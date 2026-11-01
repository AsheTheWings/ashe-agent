/**
 * The session client: connection, authentication, and session state for
 * any user interface, held in a `zustand/vanilla` store.
 */
import { sha256 } from "@noble/hashes/sha2.js"
import {
  ErrorCode,
  PROTOCOL_VERSION,
  type Agent,
  type InputMode,
  type MethodName,
  type Model,
  type ParamsOf,
  type PermissionAnswer,
  type ResultOf,
  type Sender,
  type SessionEvent,
  type SessionSummary,
} from "@ashe-agent/protocol"
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
  readonly views: Readonly<Record<string, SessionView>>
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

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

type AccessToken = { readonly token: string; readonly expiresAt: number }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

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
      views: {},
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
    this.set({ status: "signedOut", principal: null, activeSessionId: null, views: {}, sessions: [] })
  }

  private disconnect() {
    this.generation++
    this.ports.clearTimer(this.refreshTimer)
    this.ports.clearTimer(this.reconnectTimer)
    this.refreshTimer = null
    this.reconnectTimer = null
    this.access = null
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
    const side = new Connection(url, this.ports, { onEvent: () => {}, onClose: () => {} })
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
      this.scheduleRefresh(REFRESH_RETRY_DELAY_MS)
    } finally {
      if (this.side === side) this.side = null
      side.close()
    }
  }

  /** The connection dropped: reconnect after a growing delay and resubscribe. */
  private lost() {
    this.connection = null
    this.set({ status: "reconnecting" })
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
    const active = this.state.activeSessionId
    if (active !== null) await this.subscribe(connection, active)
  }

  private async subscribe(connection: Connection, sessionId: string) {
    const view = this.state.views[sessionId]
    const params = view === undefined || view.lastSeq === 0 ? { sessionId } : { sessionId, afterSeq: view.lastSeq }
    const { session } = await connection.request("session.subscribe", params)
    this.upsert(session)
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

  async createSession(options: { readonly model?: string; readonly agent?: string; readonly reasoningEffort?: string }) {
    const { session } = await this.call("session.create", options)
    this.upsert(session)
    await this.open(session.id)
    return session
  }

  /** Sends input to the open session: it steers a running turn or starts one, unless queued. */
  async send(text: string, mode?: InputMode) {
    const sessionId = this.activeId()
    await this.call("session.input", mode === undefined ? { sessionId, text } : { sessionId, text, mode })
  }

  async cancel() {
    await this.call("session.cancel", { sessionId: this.activeId() })
  }

  /** Selects the open session's model and reasoning effort; without an effort, the model's default applies. */
  async setModel(model: string, reasoningEffort?: string) {
    const sessionId = this.activeId()
    await this.call("session.setModel", reasoningEffort === undefined ? { sessionId, model } : { sessionId, model, reasoningEffort })
  }

  /** Answers the open session's question set; a question without a selection or note is skipped. */
  async answerQuestion(questionSetId: string, answers: ReadonlyArray<{ readonly id: string; readonly selection?: string; readonly note?: string }>) {
    await this.call("session.answerQuestion", { sessionId: this.activeId(), questionSetId, answers: [...answers] })
  }

  /** Answers a permission request; a message goes only with a rejection, as the call's result. */
  async answerPermission(requestId: string, answer: PermissionAnswer, message?: string) {
    const sessionId = this.activeId()
    const trimmed = answer === "reject" ? (message?.trim() ?? "") : ""
    await this.call(
      "permission.answer",
      trimmed === "" ? { sessionId, requestId, answer } : { sessionId, requestId, answer, message: trimmed },
    )
  }

  /** Removes the turn `runId` and every later one, then reruns its input, or `text` instead. */
  async rewind(runId: string, text?: string) {
    const sessionId = this.activeId()
    await this.call("session.rewind", text === undefined ? { sessionId, runId } : { sessionId, runId, text })
  }

  /** Copies the open session through the turn `runId` into a new session and opens it. */
  async fork(runId: string) {
    const { session } = await this.call("session.fork", { sessionId: this.activeId(), runId })
    this.upsert(session)
    await this.open(session.id)
    return session
  }
}
