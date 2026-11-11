/**
 * The session client: connection, authentication, and session state for
 * any user interface, held in a `zustand/vanilla` store.
 */
import { sha256 } from "@noble/hashes/sha2.js"
import {
  ErrorCode,
  PERMISSION_ACTION,
  PermissionActionArgs,
  QUESTIONS_ACTION,
  QuestionsActionArgs,
  PROTOCOL_VERSION,
  type Agent,
  type ApprovalGrant,
  type InputMode,
  type InputReceipt,
  type SessionObservation,
  type SemanticEntry,
  type SemanticPageEntry,
  type Turn,
  type BoundarySummary,
  type ModelInputManifest,
  type ModelCallUsage,
  type HistoryOperationResult,
  type MethodName,
  type Model,
  type ParamsOf,
  type PermissionAnswer,
  type ResultOf,
  type RetainedAttachmentRef,
  type SelectionPatch,
  type Sender,
  type SessionEvent,
  type SessionSummary,
} from "@ashe-agent/protocol"
import { Schema } from "effect"
import { createStore, type StoreApi } from "zustand/vanilla"
import { Connection, ConnectionClosed, ProtocolError } from "./connection.ts"
import type { SessionClientPorts } from "./ports.ts"
import { applyEvent, emptyView, type SessionView } from "./projection.ts"

export type ConnectionStatus = "signedOut" | "connecting" | "connected" | "reconnecting"

export type ClientState = {
  readonly status: ConnectionStatus
  /** The configured server's WebSocket URL. */
  readonly serverUrl: string
  readonly principal: Sender | null
  /** The last failure to show the user, cleared by the next success. */
  readonly error: string | null
  readonly models: ReadonlyArray<Model>
  readonly agents: ReadonlyArray<Agent>
  readonly sessions: ReadonlyArray<SessionSummary>
  readonly activeSessionId: string | null
  /** Selection changes this client will submit with the next input or rewind. */
  readonly requestedSelections: Readonly<Record<string, SelectionPatch>>
  readonly views: Readonly<Record<string, SessionView>>
  readonly observations: Readonly<Record<string, SessionObservation>>
  readonly semantic: Readonly<
    Record<
      string,
      {
        readonly revision: string
        readonly turns: ReadonlyArray<Turn>
        readonly entries: ReadonlyArray<SemanticPageEntry>
        readonly boundaries: ReadonlyArray<BoundarySummary>
        readonly latestSuccessfulBoundaryId: string | null
      }
    >
  >
  /** Question set and permission request ids whose live action this connection owns. */
  readonly owned: { readonly questions: ReadonlyArray<string>; readonly permissions: ReadonlyArray<string> }
}

export const storageKeys = {
  refreshToken: (serverUrl: string) => `ashe-agent.refreshToken:${serverUrl}`,
  verifier: "ashe-agent.signInVerifier",
  signInServer: "ashe-agent.signInServer",
} as const

/** How long before the access token expires the client refreshes it. */
export const REFRESH_MARGIN_MS = 60_000
/** An access token closer than this to expiry is not used to authenticate. */
const ACCESS_TOKEN_MIN_LIFE_MS = 10_000
const RECONNECT_FIRST_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000
const REFRESH_RETRY_DELAY_MS = 10_000
const REFRESH_LOCK = "ashe-agent.refresh"

type Tokens = ResultOf<"auth.exchange">
type SignInExchange = { readonly code: string; readonly verifier: string }
type PendingAction = {
  readonly actionId: string
  readonly sessionId: string
  readonly name: string
  readonly subjectId: string
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")

type AccessToken = { readonly token: string; readonly expiresAt: number }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Merges a requested patch into accumulated local changes, distinguishing omission from explicit null. */
export const mergeSelectionPatch = (
  current: SelectionPatch | undefined,
  patch: SelectionPatch,
): SelectionPatch => {
  const agentTitle = Object.hasOwn(patch, "agentTitle") ? patch.agentTitle : current?.agentTitle
  let modelSettings: { modelId?: string | null; reasoningEffort?: string | null } | undefined =
    current?.modelSettings === undefined ? undefined : { ...current.modelSettings }
  if (patch.modelSettings !== undefined) {
    modelSettings ??= {}
    if (Object.hasOwn(patch.modelSettings, "modelId")) modelSettings.modelId = patch.modelSettings.modelId!
    if (Object.hasOwn(patch.modelSettings, "reasoningEffort")) {
      modelSettings.reasoningEffort = patch.modelSettings.reasoningEffort!
    }
  }
  return {
    ...(agentTitle === undefined ? {} : { agentTitle }),
    ...(modelSettings === undefined ? {} : { modelSettings }),
  }
}

/** Tokens that arrived after a sign-in or sign-out began a new generation; they are dropped unstored. */
class Superseded extends Error {
  constructor() {
    super("superseded by a later sign-in or sign-out")
    this.name = "Superseded"
  }
}

export class SessionClient {
  readonly store: StoreApi<ClientState>
  private readonly ports: SessionClientPorts
  private connection: Connection | null = null
  private access: AccessToken | null = null
  private refreshTimer: unknown = null
  /** The connection of a refresh in progress, if any. */
  private side: Connection | null = null
  private reconnectTimer: unknown = null
  private reconnectDelay = RECONNECT_FIRST_DELAY_MS
  /** Live actions assigned to this connection, keyed by their session, name, and subject. */
  private readonly pendingActions = new Map<string, PendingAction>()
  private readonly unreconciledQuestions = new Map<string, PendingAction>()
  /** Bumped on sign-in and sign-out, so work of an earlier connection ends quietly. */
  private generation = 0

  constructor(ports: SessionClientPorts) {
    this.ports = ports
    this.store = createStore<ClientState>()(() => ({
      status: "signedOut",
      serverUrl: ports.serverUrl,
      principal: null,
      error: null,
      models: [],
      agents: [],
      sessions: [],
      activeSessionId: null,
      requestedSelections: {},
      views: {},
      observations: {},
      semantic: {},
      owned: { questions: [], permissions: [] },
    }))
  }

  private get state() {
    return this.store.getState()
  }

  private set(partial: Partial<ClientState>) {
    this.store.setState(partial)
  }

  /** Connects with the stored refresh token only when it belongs to the configured server. */
  resume() {
    if (this.completeSignIn()) return
    const url = this.state.serverUrl
    if (this.ports.storage.getItem(storageKeys.refreshToken(url)) === null) return
    this.connect(url, ++this.generation, null)
  }

  /** Starts GitHub sign-in with a verifier held by this browser tab. */
  async signIn(): Promise<void> {
    try {
      const serverUrl = this.state.serverUrl
      const start = new URL(serverUrl)
      start.protocol = start.protocol === "ws:" ? "http:" : "https:"
      start.pathname = "/v1/auth/github/start"
      start.search = ""
      start.hash = ""
      const verifier = base64url(this.ports.signIn.randomBytes())
      start.searchParams.set("origin", this.ports.signIn.origin)
      start.searchParams.set("challenge", base64url(sha256(new TextEncoder().encode(verifier))))
      this.ports.signIn.storage.setItem(storageKeys.verifier, verifier)
      this.ports.signIn.storage.setItem(storageKeys.signInServer, serverUrl)
      this.set({ error: null })
      this.ports.signIn.navigate(start.href)
    } catch (error) {
      this.set({ error: messageOf(error) })
    }
  }

  /** Removes a callback's fragment before opening any connection. */
  private completeSignIn(): boolean {
    const fragment = new URLSearchParams(this.ports.signIn.fragment().replace(/^#/, ""))
    if (!fragment.has("signIn") && !fragment.has("signInError")) return false
    this.ports.signIn.clearFragment()
    const storage = this.ports.signIn.storage
    const verifier = storage.getItem(storageKeys.verifier)
    const serverUrl = storage.getItem(storageKeys.signInServer)
    storage.removeItem(storageKeys.verifier)
    storage.removeItem(storageKeys.signInServer)
    const error = fragment.get("signInError")
    if (error !== null) {
      const messages: Record<string, string> = {
        denied: "GitHub sign-in was denied. Try again when you are ready.",
        not_owner: "This GitHub account is not the server's owner.",
        github_failed: "GitHub sign-in failed. Please try again.",
      }
      this.set({ error: messages[error] ?? "Sign-in failed. Please try again." })
      return true
    }
    if (!verifier || !serverUrl || serverUrl !== this.state.serverUrl) {
      this.set({ error: "This tab has no pending sign-in. Start again with Continue with GitHub." })
      return true
    }
    this.disconnect()
    this.set({ error: null })
    void this.connect(serverUrl, ++this.generation, { code: fragment.get("signIn")!, verifier })
    return true
  }

  /** Signs out on this browser: forgets the tokens and closes the connection. */
  signOut() {
    this.disconnect()
    this.ports.storage.removeItem(storageKeys.refreshToken(this.state.serverUrl))
    this.set({
      status: "signedOut",
      principal: null,
      activeSessionId: null,
      views: {},
      observations: {},
      semantic: {},
      sessions: [],
      requestedSelections: {},
      owned: { questions: [], permissions: [] },
    })
  }

  private disconnect() {
    this.generation++
    this.ports.clearTimer(this.refreshTimer)
    this.ports.clearTimer(this.reconnectTimer)
    this.refreshTimer = null
    this.reconnectTimer = null
    this.access = null
    this.pendingActions.clear()
    this.set({ owned: { questions: [], permissions: [] } })
    const connection = this.connection
    this.connection = null
    connection?.close()
    const side = this.side
    this.side = null
    side?.close()
  }

  private async connect(url: string, generation: number, exchange: SignInExchange | null): Promise<void> {
    const current = () => generation === this.generation
    let authenticated = false
    this.set({ status: this.state.principal === null ? "connecting" : "reconnecting" })
    const connection = new Connection(url, this.ports, {
      onEvent: (event) => {
        if (current()) this.apply(event)
      },
      onActionExecute: (action) => {
        if (current()) this.receiveAction(action)
      },
      onActionCancel: (action) => {
        if (current()) this.cancelAction(action.actionId)
      },
      onClose: () => {
        // A sign-in that fails reports it; every other dropped connection reconnects.
        if (current() && this.connection === connection && (authenticated || exchange === null)) this.lost()
      },
    })
    this.connection = connection
    let principal: Sender
    try {
      principal = await this.authenticate(connection, exchange, generation)
    } catch (error) {
      if (!current()) return
      if (error instanceof ConnectionClosed && exchange === null) return
      const signedOut = error instanceof ProtocolError && error.code === ErrorCode.authenticationFailed
      if (signedOut) this.signOut()
      else this.disconnect()
      const message = error instanceof ConnectionClosed ? `could not connect to ${url}` : messageOf(error)
      this.set({ status: "signedOut", principal: null, error: message })
      return
    }
    if (!current()) return
    authenticated = true
    this.reconnectDelay = RECONNECT_FIRST_DELAY_MS
    this.set({ status: "connected", principal, error: null })
    try {
      await this.load(connection)
    } catch (error) {
      if (!current() || error instanceof ConnectionClosed) return
      this.set({ error: messageOf(error) })
      connection.close()
    }
  }

  /** Authenticates a new connection with a sign-in code, an access token, or a refresh token. */
  private async authenticate(connection: Connection, exchange: SignInExchange | null, generation: number): Promise<Sender> {
    const protocolVersion = PROTOCOL_VERSION
    if (exchange !== null) {
      return this.accept(await connection.request("auth.exchange", { ...exchange, protocolVersion }), generation)
    }
    const access = this.access
    if (access !== null && access.expiresAt - this.ports.now() > ACCESS_TOKEN_MIN_LIFE_MS) {
      const { principal } = await connection.request("auth.authenticate", { token: access.token, protocolVersion })
      return principal
    }
    return await this.refreshOn(connection, generation)
  }

  /** Exchanges the stored refresh token on `connection`, holding the refresh lock throughout. */
  private refreshOn(connection: Connection, generation: number): Promise<Sender> {
    return this.ports.withLock(REFRESH_LOCK, async () => {
      // Read inside the lock: another page may have just exchanged the token it held.
      const refreshToken = this.ports.storage.getItem(storageKeys.refreshToken(this.state.serverUrl))
      if (refreshToken === null) {
        throw new ProtocolError({ code: ErrorCode.authenticationFailed, message: "signed out" })
      }
      const tokens = await connection.request("auth.refresh", { refreshToken, protocolVersion: PROTOCOL_VERSION })
      return this.accept(tokens, generation)
    })
  }

  /** Stores the tokens of `generation`, unless a sign-in or sign-out has begun another since. */
  private accept(tokens: Tokens, generation: number): Sender {
    if (generation !== this.generation) throw new Superseded()
    this.ports.storage.setItem(storageKeys.refreshToken(this.state.serverUrl), tokens.refreshToken)
    this.access = { token: tokens.accessToken, expiresAt: tokens.accessTokenExpiresAt }
    this.scheduleRefresh(tokens.accessTokenExpiresAt - REFRESH_MARGIN_MS - this.ports.now())
    return tokens.principal
  }

  private scheduleRefresh(delayMs: number) {
    this.ports.clearTimer(this.refreshTimer)
    const generation = this.generation
    this.refreshTimer = this.ports.setTimer(() => {
      if (generation === this.generation) void this.refresh(generation)
    }, Math.max(0, delayMs))
  }

  /** Refreshes the tokens on a connection of its own, which closes once it has them. */
  private async refresh(generation: number) {
    const url = this.state.serverUrl
    const side = new Connection(url, this.ports, {
      onEvent: () => {},
      onActionExecute: () => {},
      onActionCancel: () => {},
      onClose: () => {},
    })
    this.side = side
    try {
      await this.refreshOn(side, generation)
    } catch (error) {
      if (generation !== this.generation) return
      if (error instanceof ProtocolError && error.code === ErrorCode.authenticationFailed) {
        this.signOut()
        this.set({ error: "the session expired; sign in again" })
        return
      }
      if (error instanceof Error && (error.message.includes("Web Locks") || error.name === "AbortError" || error.name === "SecurityError")) {
        this.set({ error: "secure browser coordination is unavailable; sign in again in a secure context" })
        return
      }
      this.scheduleRefresh(REFRESH_RETRY_DELAY_MS)
    } finally {
      if (this.side === side) this.side = null
      side.close()
    }
  }

  /** The connection dropped: reconnect after a growing delay and resubscribe. */
  private lost() {
    this.connection = null
    this.pendingActions.clear()
    this.set({ status: "reconnecting", owned: { questions: [], permissions: [] } })
    const url = this.state.serverUrl
    const generation = this.generation
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS)
    this.reconnectTimer = this.ports.setTimer(() => {
      if (generation === this.generation) void this.connect(url, generation, null)
    }, delay)
  }

  /** Loads the lists and resubscribes the open session after its last seen event. */
  private async load(connection: Connection) {
    const [{ models }, { agents }, { sessions }] = await Promise.all([
      connection.request("models.list", {}),
      connection.request("agents.list", {}),
      connection.request("session.list", {}),
    ])
    this.set({ models, agents, sessions })
    const { actions } = await connection.request("actions.list", {})
    const supported = actions
      .map((action) => action.name)
      .filter((name) => name === QUESTIONS_ACTION || name === PERMISSION_ACTION)
    await connection.request("client.setActions", { actions: supported })
    const active = this.state.activeSessionId
    if (active !== null) await this.subscribe(connection, active)
  }

  private async subscribe(connection: Connection, sessionId: string) {
    const view = this.state.views[sessionId]
    const params = view === undefined || view.lastSeq === 0 ? { sessionId } : { sessionId, afterSeq: view.lastSeq }
    const { session } = await connection.request("session.subscribe", params)
    this.upsert(session)
    setTimeout(() => {
      void this.observe(sessionId).catch(() => {})
      void this.reloadSemantic(sessionId).catch(() => {})
    }, 0)
  }

  private upsert(session: SessionSummary) {
    const sessions = this.state.sessions.filter((known) => known.id !== session.id)
    this.set({ sessions: [session, ...sessions].sort((a, b) => b.createdAt - a.createdAt) })
  }

  private apply(event: SessionEvent) {
    const views = this.state.views
    const view = views[event.sessionId] ?? emptyView(event.sessionId)
    const next = applyEvent(view, event)
    if (next !== view) this.set({ views: { ...views, [event.sessionId]: next } })
    if (
      ["OBSERVATION_CHANGED", "INPUT_WAITING", "INPUT_RECEIVED", "SELECTION_CHANGED", "SESSION_REWOUND", "RUN_STARTED", "RUN_FINISHED", "ACTION_ATTENTION", "ACTION_SETTLED"].includes(event.event.type)
    ) {
      void this.observe(event.sessionId).catch(() => {})
    }
    if (["SESSION_REWOUND", "MODEL_CALL_COMMITTED", "RUN_FINISHED", "RUN_ERROR"].includes(event.event.type)) {
      void this.reloadSemantic(event.sessionId).catch(() => {})
    }
  }

  /** Records a declared action so the UI's answer can complete this exact assignment. */
  private receiveAction(action: { actionId: string; sessionId: string; name: string; arguments: unknown }) {
    let subjectId: string
    if (action.name === QUESTIONS_ACTION) {
      const decoded = Schema.decodeUnknownResult(QuestionsActionArgs)(action.arguments)
      if (decoded._tag === "Failure") return
      subjectId = decoded.success.questionSetId
    } else if (action.name === PERMISSION_ACTION) {
      const decoded = Schema.decodeUnknownResult(PermissionActionArgs)(action.arguments)
      if (decoded._tag === "Failure") return
      subjectId = decoded.success.requestId
    } else return
    this.pendingActions.set(`${action.sessionId}:${action.name}:${subjectId}`, { ...action, subjectId })
    const questions =
      action.name === QUESTIONS_ACTION
        ? [...this.state.owned.questions.filter((id) => id !== subjectId), subjectId]
        : this.state.owned.questions
    const permissions =
      action.name === PERMISSION_ACTION
        ? [...this.state.owned.permissions.filter((id) => id !== subjectId), subjectId]
        : this.state.owned.permissions
    this.set({ owned: { questions, permissions } })
  }

  private cancelAction(actionId: string) {
    for (const [key, action] of this.pendingActions) {
      if (action.actionId !== actionId) continue
      this.pendingActions.delete(key)
      const field = action.name === QUESTIONS_ACTION ? "questions" : "permissions"
      this.set({ owned: { ...this.state.owned, [field]: this.state.owned[field].filter((id) => id !== action.subjectId) } })
    }
  }

  private async completeAction(action: PendingAction, result: unknown) {
    try {
      await this.call("action.complete", { sessionId: action.sessionId, actionId: action.actionId, result })
    } finally {
      const key = `${action.sessionId}:${action.name}:${action.subjectId}`
      if (this.pendingActions.get(key)?.actionId === action.actionId) this.pendingActions.delete(key)
      const field = action.name === QUESTIONS_ACTION ? "questions" : "permissions"
      this.set({ owned: { ...this.state.owned, [field]: this.state.owned[field].filter((id) => id !== action.subjectId) } })
    }
  }

  private async call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    const connection = this.connection
    if (connection === null || this.state.status !== "connected") throw new ConnectionClosed()
    try {
      return await connection.request(method, params)
    } catch (error) {
      this.set({ error: messageOf(error) })
      throw error
    }
  }

  private activeId(): string {
    const sessionId = this.state.activeSessionId
    if (sessionId === null) throw new Error("no session is open")
    return sessionId
  }

  async refreshSessions() {
    const { sessions } = await this.call("session.list", {})
    this.set({ sessions })
  }

  /** Opens a session: unsubscribes the one open before and subscribes after its last seen event. */
  async open(sessionId: string) {
    const previous = this.state.activeSessionId
    if (previous === sessionId) return
    this.set({ activeSessionId: sessionId, error: null })
    const connection = this.connection
    if (connection === null || this.state.status !== "connected") return
    if (previous !== null) void connection.request("session.unsubscribe", { sessionId: previous }).catch(() => {})
    await this.subscribe(connection, sessionId)
  }

  async createSession(options: {
    readonly model?: string | null
    readonly agent?: string
    readonly reasoningEffort?: string | null
  }) {
    const selection: SelectionPatch = {
      ...(options.agent === undefined ? {} : { agentTitle: options.agent }),
      ...(options.model === undefined && options.reasoningEffort === undefined
        ? {}
        : {
            modelSettings: {
              ...(options.model === undefined ? {} : { modelId: options.model }),
              ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
            },
          }),
    }
    const { session } = await this.call(
      "session.create",
      Object.keys(selection).length === 0 ? {} : { selection },
    )
    this.upsert(session)
    await this.open(session.id)
    return session
  }

  /** Sends input to the open session as steering unless queued. */
  async send(text: string, mode?: InputMode) {
    const sessionId = this.activeId()
    const question = [...this.pendingActions.values()].find(
      (action) => action.sessionId === sessionId && action.name === QUESTIONS_ACTION,
    )
    const selection = this.state.requestedSelections[sessionId]
    const result = await this.call("session.input", {
      sessionId,
      text,
      ...(mode === undefined ? {} : { mode }),
      ...(selection === undefined ? {} : { selection }),
      submissionId: crypto.randomUUID(),
    })
    if (selection !== undefined && this.state.requestedSelections[sessionId] === selection) {
      const requestedSelections = { ...this.state.requestedSelections }
      delete requestedSelections[sessionId]
      this.set({ requestedSelections })
    }
    if (question !== undefined && mode !== "queue") {
      await this.completeAction(question, { kind: "repliedByMessage" }).catch(() => {})
    }
    return result
  }

  /** Submits one immutable snapshot with a caller-owned identity. */
  async submit(
    sessionId: string,
    input: {
      readonly text: string
      readonly mode: InputMode
      readonly submissionId: string
      readonly attachments?: ReadonlyArray<RetainedAttachmentRef>
      readonly selection?: SelectionPatch
    },
  ): Promise<InputReceipt> {
    const question = [...this.pendingActions.values()].find(
      (action) => action.sessionId === sessionId && action.name === QUESTIONS_ACTION,
    )
    if (question !== undefined && input.mode !== "queue") this.unreconciledQuestions.set(input.submissionId, question)
    const result = await this.call("session.input", {
      sessionId,
      text: input.text,
      mode: input.mode,
      submissionId: input.submissionId,
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      ...(input.selection === undefined ? {} : { selection: input.selection }),
    })
    if (question !== undefined && input.mode !== "queue") {
      await this.completeAction(question, { kind: "repliedByMessage" }).catch(() => {})
      this.unreconciledQuestions.delete(input.submissionId)
    }
    return result.receipt
  }

  async cancel(expected?: string) {
    const sessionId = this.activeId()
    const expectedTurnId = expected ?? this.state.views[sessionId]?.runId
    if (expectedTurnId === null || expectedTurnId === undefined) return
    return this.call("session.cancel", { sessionId, expectedTurnId })
  }

  /** Resumes the open session with continuation content; the server refuses while it is active. */
  async resumeSession() {
    await this.call("session.resume", { sessionId: this.activeId() })
  }

  /** Accumulates a local selection change until the next message or rewind submission. */
  async setSelection(patch: SelectionPatch) {
    const sessionId = this.activeId()
    const current = this.state.requestedSelections[sessionId]
    this.set({
      requestedSelections: {
        ...this.state.requestedSelections,
        [sessionId]: mergeSelectionPatch(current, patch),
      },
    })
  }

  /** Requests a title change without changing an omitted model or effort. */
  async setAgentTitle(agentTitle: string) {
    await this.setSelection({ agentTitle })
  }

  /** Requests a model change, starting at its default effort unless one is given. */
  async setModel(model: string, reasoningEffort?: string) {
    await this.setSelection({ modelSettings: { modelId: model, reasoningEffort: reasoningEffort ?? null } })
  }

  /** Requests an explicit effort, or null for the requested model's default. */
  async setReasoningEffort(reasoningEffort: string | null) {
    await this.setSelection({ modelSettings: { reasoningEffort } })
  }

  /** Requests the explicitly unconfigured model state. */
  async clearModel() {
    await this.setSelection({ modelSettings: { modelId: null, reasoningEffort: null } })
  }

  /** Answers the open session's question set; a question without a selection or note is skipped. */
  async answerQuestion(questionSetId: string, answers: ReadonlyArray<{ readonly id: string; readonly selection?: string; readonly note?: string }>) {
    const sessionId = this.activeId()
    const action = this.pendingActions.get(`${sessionId}:${QUESTIONS_ACTION}:${questionSetId}`)
    if (action === undefined) throw new Error("the question set is no longer waiting for an answer")
    await this.completeAction(action, { kind: "answered", answers: [...answers] })
  }

  /** Answers a permission request; a message goes only with a rejection, as the call's result. */
  async answerPermission(requestId: string, answer: PermissionAnswer, message?: string) {
    const sessionId = this.activeId()
    const trimmed = answer === "reject" ? (message?.trim() ?? "") : ""
    const action = this.pendingActions.get(`${sessionId}:${PERMISSION_ACTION}:${requestId}`)
    if (action === undefined) throw new Error("the permission request is no longer waiting for an answer")
    await this.completeAction(action, trimmed === "" ? { answer } : { answer, message: trimmed })
  }

  /** The current access credential, for the separately authenticated web-state socket. */
  accessToken(): { readonly token: string; readonly expiresAt: number } | null {
    return this.access
  }

  /** Renews the access credential on a side connection without replacing the direct harness socket. */
  async renewAccessToken(): Promise<void> {
    if (this.state.status !== "connected" || this.connection === null) return
    const generation = this.generation
    const side = new Connection(this.state.serverUrl, this.ports, {
      onEvent: () => {},
      onActionExecute: () => {},
      onActionCancel: () => {},
      onClose: () => {},
    })
    this.side = side
    try {
      await this.refreshOn(side, generation)
    } finally {
      if (this.side === side) this.side = null
      side.close()
    }
  }

  /** A coherent owner observation for one session, cached for the UI. */
  async observe(sessionId: string): Promise<SessionObservation> {
    const observation = await this.call("session.observe", { sessionId })
    this.set({ observations: { ...this.state.observations, [sessionId]: observation } })
    return observation
  }

  /** Reads every bounded page of a session's semantic history under one revision. */
  async reloadSemantic(sessionId: string): Promise<void> {
    if (this.connection === null || this.state.status !== "connected") return
    const firstEntries = await this.call("session.semantics.page", { sessionId, object: "entries", limit: 200 })
    if (firstEntries.object !== "entries") throw new Error("the harness returned the wrong semantic page")
    const revision = firstEntries.revision
    const entries = [...firstEntries.items]
    let cursor = firstEntries.nextCursor
    while (cursor !== null) {
      const page = await this.call("session.semantics.page", { sessionId, object: "entries", revision, cursor, limit: 200 })
      if (page.object !== "entries" || page.revision !== revision) throw new Error("the semantic page revision changed")
      entries.push(...page.items)
      cursor = page.nextCursor
    }
    const turnsFirst = await this.call("session.semantics.page", { sessionId, object: "turns", revision, limit: 200 })
    if (turnsFirst.object !== "turns") throw new Error("the harness returned the wrong turn page")
    const turns = [...turnsFirst.items]
    cursor = turnsFirst.nextCursor
    while (cursor !== null) {
      const page = await this.call("session.semantics.page", { sessionId, object: "turns", revision, cursor, limit: 200 })
      if (page.object !== "turns") throw new Error("the harness returned the wrong turn page")
      turns.push(...page.items)
      cursor = page.nextCursor
    }
    const boundariesFirst = await this.call("session.semantics.page", { sessionId, object: "boundaries", revision, limit: 200 })
    if (boundariesFirst.object !== "boundaries") throw new Error("the harness returned the wrong boundary page")
    const boundaries = [...boundariesFirst.items]
    cursor = boundariesFirst.nextCursor
    while (cursor !== null) {
      const page = await this.call("session.semantics.page", { sessionId, object: "boundaries", revision, cursor, limit: 200 })
      if (page.object !== "boundaries") throw new Error("the harness returned the wrong boundary page")
      boundaries.push(...page.items)
      cursor = page.nextCursor
    }
    this.set({
      semantic: {
        ...this.state.semantic,
        [sessionId]: {
          revision,
          turns,
          entries,
          boundaries,
          latestSuccessfulBoundaryId: firstEntries.latestSuccessfulBoundaryId,
        },
      },
    })
  }

  async semanticBody(sessionId: string, entryId: string, contentId: string): Promise<SemanticEntry> {
    return (await this.call("session.semantics.body", { sessionId, entryId, contentId })).entry
  }

  async semanticBoundary(sessionId: string, manifestId: string): Promise<ModelInputManifest> {
    return (await this.call("session.semantics.boundary", { sessionId, manifestId })).boundary
  }

  async modelUsage(sessionId: string, modelCallIds: ReadonlyArray<string>): Promise<ReadonlyArray<ModelCallUsage>> {
    return (await this.call("session.modelCalls.usage", { sessionId, modelCallIds: [...modelCallIds] })).usage
  }

  async capture(sessionId: string, entryId: string, contentId: string, offset: number, length: number) {
    return (await this.call("content.capture", { sessionId, entryId, contentId, offset, length })).capture
  }

  async inputReceipt(sessionId: string, submissionId: string): Promise<InputReceipt | null> {
    const result = await this.call("session.input.receipt", { sessionId, submissionId })
    return result.kind === "observed" ? result.receipt : null
  }

  /** Completes a steering question after a receipt proves the lost input was accepted. */
  async reconcileSubmission(sessionId: string, submissionId: string): Promise<void> {
    const question = this.unreconciledQuestions.get(submissionId)
    if (question === undefined || question.sessionId !== sessionId) return
    this.unreconciledQuestions.delete(submissionId)
    await this.completeAction(question, { kind: "repliedByMessage" }).catch(() => {})
  }

  async grants(sessionId: string): Promise<ReadonlyArray<ApprovalGrant>> {
    return (await this.call("session.grants.list", { sessionId })).grants
  }

  async clearGrants(sessionId: string, agentTitle: string): Promise<number> {
    return (await this.call("session.grants.clear", { sessionId, agentTitle })).cleared
  }

  async historyResult(sessionId: string, operationId: string): Promise<HistoryOperationResult> {
    return this.call("session.history.result", { sessionId, operationId })
  }

  /** Uploads one file into a draft-owned staging area and returns its retained reference. */
  async uploadFile(file: File, draftId: string): Promise<RetainedAttachmentRef> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const digest = hex(sha256(bytes))
    let upload = (
      await this.call("upload.create", {
        draftId,
        name: file.name,
        mediaType: file.type === "" ? "application/octet-stream" : file.type,
        size: bytes.byteLength,
      })
    ).upload
    for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
      upload = (
        await this.call("upload.append", {
          uploadId: upload.uploadId,
          offset,
          data: base64(bytes.slice(offset, offset + 64 * 1024)),
        })
      ).upload
    }
    upload = (await this.call("upload.finalize", { uploadId: upload.uploadId, size: bytes.byteLength, digest })).upload
    if (upload.attachmentId === undefined || upload.contentId === undefined) {
      throw new Error("the upload did not return a retained attachment identity")
    }
    return {
      attachmentId: upload.attachmentId,
      contentId: upload.contentId,
      representationId: upload.contentId,
      name: upload.filename,
      mediaType: upload.mediaType,
      digest,
    }
  }

  /** Rechecks staging by upload identity; an expired upload needs explicit reselection. */
  async uploadStatus(uploadId: string) {
    return (await this.call("upload.status", { uploadId })).upload
  }

  /** Fetches one retained representation with the current access credential; never a token URL. */
  async downloadContent(sessionId: string, contentId: string, referenceId: string): Promise<Blob> {
    const token = this.access?.token
    if (token === undefined) throw new Error("not signed in")
    const url = new URL(this.state.serverUrl)
    url.protocol = url.protocol === "wss:" ? "https:" : "http:"
    url.pathname = `/v1/content/${encodeURIComponent(sessionId)}/${encodeURIComponent(contentId)}/${encodeURIComponent(referenceId)}`
    url.search = ""
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error(response.status === 401 ? "sign in again" : `content download failed (${response.status})`)
    return (await response.blob()) as Blob
  }

  /** Removes the turn `runId` and every later one, then reruns its input, or `text` instead. */
  async rewind(runId: string, text?: string, operationId = crypto.randomUUID(), selection?: SelectionPatch) {
    const sessionId = this.activeId()
    const requested = selection ?? this.state.requestedSelections[sessionId]
    const inspected = await this.call("session.history.inspect", { sessionId, runId })
    if (inspected.target === null || !inspected.target.rewindEligible) {
      throw new Error("the turn is no rewind point")
    }
    await this.call("session.rewind", {
      sessionId,
      runId,
      historyScope: inspected.scope.token,
      operationId,
      ...(text === undefined ? {} : { text }),
      ...(requested === undefined ? {} : { selection: requested }),
    })
    if (requested !== undefined && this.state.requestedSelections[sessionId] === requested) {
      const requestedSelections = { ...this.state.requestedSelections }
      delete requestedSelections[sessionId]
      this.set({ requestedSelections })
    }
  }

  /** Copies the open session through the turn `runId` into a new session and opens it. */
  async fork(runId: string, operationId = crypto.randomUUID()) {
    const sessionId = this.activeId()
    const inspected = await this.call("session.history.inspect", { sessionId, runId })
    if (inspected.target === null || !inspected.target.forkEligible) {
      throw new Error("the turn is no fork point")
    }
    const { session } = await this.call("session.fork", {
      sessionId,
      runId,
      historyScope: inspected.scope.token,
      operationId,
    })
    this.upsert(session)
    await this.open(session.id)
    return session
  }
}
