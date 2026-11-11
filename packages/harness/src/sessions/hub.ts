import type { AIMessage } from "@langchain/core/messages"
import { context as otelContext, type Context as TraceContext, type Span } from "@opentelemetry/api"
import { Context, Effect, Exit, Fiber, Layer } from "effect"
import {
  type Agent,
  type AgentProfile,
  ErrorCode,
  type InputMode,
  type Model,
  PERMISSION_ACTION,
  type PermissionActionResult,
  type RetainedAttachmentRef,
  type SelectionPatch,
  type Sender,
  type SessionEvent,
  type SessionEventBody,
  type SessionSummary,
  type TurnInput,
  UNTITLED_AGENT_TITLE,
} from "@ashe-agent/protocol"
import type { ModelPort } from "../agent/model.ts"
import { programCallsNote, unfinishedResult } from "../agent/notes.ts"
import { withholdingName, type Tool } from "../agent/tools.ts"
import type { ToolContent, ToolOutcome } from "../agent/window.ts"
import type { SessionAgent } from "../agents/agents.ts"
import { AttachmentError, AttachmentStore, type UploadLimits } from "../content/attachments.ts"
import { InstructionsUnreadable, type KnownInstructions } from "../agents/setup.ts"
import { displayTitle, type FileMetadata } from "../agents/titles.ts"
import {
  currentDates,
  continuationComponent,
  datesChanged,
  forkComponent,
  harnessInstructions,
  memoryRestored,
  rewindComponent,
  scratchLost,
  sameDates,
  type Component,
  type SourceStates,
} from "../context/components.ts"
import { SCRATCH_FORK_MAX_BYTES, SESSION_ID_LENGTH } from "../context/constants.ts"
import { allowanceMessage, catalogChanges, instructionsChange, renderSeed, seedTokens } from "../context/seed.ts"
import { CONTEXT_TURN_TOOLS, UNCHECKED_CONTEXT_TOOLS } from "../context/tools.ts"
import type { AuxiliaryModels, Permission } from "../inputs/shapes.ts"
import { checkpointWindowSize, type ConfiguredModel } from "../models/registry.ts"
import {
  compileRules,
  decide,
  PermissionDenied,
  PermissionRejected,
  whollyDenied,
  type PermissionCheck,
  type Rule,
} from "../permissions/rules.ts"
import { ProtocolError } from "../server/websocket.ts"
import { Store } from "../store/database.ts"
import { endSpan, isErrorClass, recordDuration, startSpan, traced, withSpan, type ErrorClass } from "../telemetry/signals.ts"
import { toolPolicy as defaultToolPolicy, type ToolExecutionPolicy } from "../agent/tools.ts"
import { ContextTurns } from "./context-turns.ts"
import { ActionBroker } from "./actions.ts"
import { IntegrityFailure } from "../agent/failure.ts"
import type { Item, NewWaitingEntry, WaitingEntry } from "./conversation.ts"
import type { FileRef } from "./file-state.ts"
import { SessionFiles, type StoredFile } from "./files.ts"
import { SessionStore, type Catalogs, type SessionRecord, type TurnRecord } from "./store.ts"

export type { Catalogs } from "./store.ts"

/** What a turn's runner gets from the hub. */
export interface TurnContext {
  readonly session: SessionRecord
  readonly turn: TurnRecord
  /** Persists an event of the turn and sends it to every subscriber. */
  readonly emit: (body: SessionEventBody) => SessionEvent
  /** The session's current checkpoint window: its harness instructions and its items. */
  readonly window: () => { readonly position: number; readonly harness: string; readonly items: ReadonlyArray<Item> }
  /** The tools the session's rules leave offered now. */
  readonly tools: () => ReadonlyArray<Tool>
  /** Freezes a model call's request before it is sent and records that it started. */
  readonly storeContent: (sha256: string, text: string) => void
  /** Freezes a model call's request before it is sent and records that it started. */
  readonly beginModelCall: (call: {
    readonly modelCallId: string
    readonly inputBoundaryId: string
    readonly ordinal: number
    readonly windowPosition: number
    readonly request: unknown
    readonly offeredTools: unknown
  }) => void
  /** Records a model call that ended without a retained response. */
  readonly discardModelCall: (modelCallId: string, outcome: "failed" | "cancelled" | "interrupted") => void
  /** Records a model call's assistant message as an item, in one transaction with the events that end its streams. */
  readonly commitAssistant: (
    message: AIMessage,
    events: ReadonlyArray<SessionEventBody>,
    modelCallId: string,
  ) => ReadonlyArray<string>
  /** Runs post-commit context work after the assistant commit becomes durable. */
  readonly afterCommit: () => void
  /** Records a tool result as an item, in one transaction with its `TOOL_CALL_RESULT` event. */
  readonly commitResult: (
    result: { readonly callId: string; readonly name: string; readonly content: ToolContent; readonly outcome: ToolOutcome },
    event: SessionEventBody,
    modelCallId: string,
    invocationId?: string,
  ) => void
  /** Records the actual start of an owned tool invocation. */
  readonly toolStarted: (invocationId: string) => void
  /**
   * At a complete step boundary, whether another input batch is eligible to
   * start the next turn. It never appends to the admitted turn.
   */
  readonly deliver: () => boolean
  /** Whether a cancel request, rather than a server stop, is ending the turn. */
  readonly isCancelled: () => boolean
  /**
   * Decides a tool call by the global rules, the session agent's rules, and
   * the session's grants. It returns when the call may run, waiting on an
   * ask until a client answers; it throws `PermissionDenied` for a denied
   * call, `PermissionRejected` for a rejected one, and the abort reason
   * when `signal` aborts while it waits.
   */
  readonly authorize: (toolCallId: string, check: PermissionCheck, signal: AbortSignal) => Promise<void>
  /** The trace context holding the turn's span, the parent of its model and tool call spans. */
  readonly trace: TraceContext
  /** Whether the session's rules leave `tool` offered: false for a tool they wholly deny. */
  readonly offered: (tool: Tool) => boolean
  /** The elapsed-time policy shared by every direct and code-mode tool invocation. */
  readonly toolPolicy: ToolExecutionPolicy
  /** The checkpoint window size of the turn's model for the session's agent. */
  readonly checkpointWindowSize: number
  /** Whether the turn is a context turn now. */
  readonly isContextTurn: () => boolean
  /** A model call would leave less than the reserve: start a context workflow and end this turn. */
  readonly reserveReached: (signal: AbortSignal) => void
  /**
   * A model call reached the context limit: the turn is cleared, becoming a
   * context turn, and retries the call, or after its third clearing hands
   * off and ends, the next checkpoint window constructed.
   */
  readonly limitReached: (signal: AbortSignal) => Promise<"retry" | "handoff" | "ended">
  /**
   * A context turn went idle: it goes on after a trim or a failed
   * validation, or ends with the next checkpoint window constructed. A
   * failure throws `TurnFailure`.
   */
  readonly idle: (signal: AbortSignal) => Promise<"handoff" | "ended">
}

export type TurnOutcome =
  | { readonly status: "finished" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly message: string; readonly code?: string }

/** Runs one turn to its end; interrupting it cancels the turn. */
export type TurnRunner = (context: TurnContext) => Effect.Effect<TurnOutcome>

/** A version of a session's user instructions: where it was read and what it says. */
export interface UserInstructions {
  /** The agent's title file, or the global instructions file. */
  readonly source: "title" | "global"
  readonly path: string
  readonly text: string
  readonly sha256: string
  readonly metadata: FileMetadata
}

/** What a session takes from its agent, and the sources its developer components give. */
export interface SessionSetup {
  /** The agent a new session runs as; it throws a `ProtocolError` for a key that is no agent. */
  readonly resolve: (agent: string | null) => SessionAgent
  /**
   * The agent's user instructions as they stand now, or null when there are
   * none, or "unchanged" when the chosen file is `known`'s with the same
   * metadata; it throws `InstructionsUnreadable` when the chosen source
   * exists but cannot be used.
   */
  readonly userInstructions: (agent: SessionAgent, known?: KnownInstructions) => UserInstructions | null | "unchanged"
  /** The catalogs as they stand now, without what `rules` deny. */
  readonly catalogs: (rules: ReadonlyArray<Rule>) => Catalogs
  /** The configured agents and the default one. */
  readonly agents: () => { readonly agents: ReadonlyArray<Agent>; readonly defaultAgent: string | null }
}

export interface HubOptions {
  readonly models: ReadonlyArray<ConfiguredModel>
  /** The model port auxiliary calls go to. */
  readonly port: ModelPort
  /** The model of each auxiliary task; a task without one uses the model of the session's latest turn. */
  readonly auxiliaryModels?: AuxiliaryModels
  /** The model sessions start with when neither the request nor the agent names one. */
  readonly defaultModel: string
  readonly runner: TurnRunner
  readonly setup: SessionSetup
  /** The sessions' directories, memory generations, and scratch targets. */
  readonly files: SessionFiles
  /** The tools available now, before a session's rules withhold any. */
  readonly tools?: () => ReadonlyArray<Tool>
  /** The global permission rules. */
  readonly permission?: Permission
  /** The home directory `~` and `$HOME` patterns expand to. */
  readonly home?: string
  /** The user's IANA time zone; UTC when unset. */
  readonly userTimeZone?: string
  /** The server's own time zone; the process's when unset. */
  readonly serverTimeZone?: string
  /** Elapsed-time limits for every tool invocation; a 300000 ms global limit when unset. */
  readonly toolPolicy?: ToolExecutionPolicy
  readonly uploads?: AttachmentStore
  readonly uploadLimits?: UploadLimits
  readonly now?: () => number
}

type Listener = (event: SessionEvent) => void

interface Live {
  fiber: Fiber.Fiber<TurnOutcome>
  readonly turn: TurnRecord
  cancelled: boolean
  readonly span: Span
  readonly startedAt: number
}

type AskOutcome = { readonly kind: "allowed" } | { readonly kind: "rejected"; readonly message: string | undefined }

/** A permission request waiting for an answer, in memory only. */
interface Ask {
  readonly runId: string
  readonly agentTitle: string
  readonly rules: ReadonlyArray<Rule>
  readonly check: PermissionCheck
  actionId: string | null
  readonly settle: (outcome: AskOutcome) => void
  readonly fail: (error: Error) => void
}

class PermissionCollectionUnavailable extends Error {}

interface SessionState {
  readonly listeners: Set<Listener>
  live: Live | null
  /** A history operation owns advancement until it settles the prior turn and commits its replacement. */
  controlled: boolean
  /** Resolves once the interrupted turn's settlement callback has finished. */
  settled: (() => void) | null
  /** Permission requests waiting for an answer, by request id, in arrival order. */
  readonly asks: Map<string, Ask>
}

type Append = (body: SessionEventBody) => SessionEvent

const notFound = (what: string) => new ProtocolError({ code: ErrorCode.notFound, message: `no ${what}` })
const conflict = (message: string) => new ProtocolError({ code: ErrorCode.conflict, message })
const invalid = (message: string) => new ProtocolError({ code: ErrorCode.invalidInput, message })
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const senderOwner = (sender: Sender) => (sender.kind === "token" ? `token:${sender.tokenId}` : `login:${sender.loginId}`)

const SESSION_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
/** The largest multiple of the alphabet's size below 256: bytes from it on are discarded, so each character is uniform. */
const SESSION_ID_BYTE_LIMIT = 256 - (256 % SESSION_ID_ALPHABET.length)

/** A random session id of `a-z` and `0-9` from a cryptographically secure source. */
export const randomSessionId = (): string => {
  let id = ""
  while (id.length < SESSION_ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(SESSION_ID_LENGTH * 2))) {
      if (byte < SESSION_ID_BYTE_LIMIT && id.length < SESSION_ID_LENGTH) id += SESSION_ID_ALPHABET[byte % SESSION_ID_ALPHABET.length]
    }
  }
  return id
}

const wire = (component: Component) => ({ type: component.type, heading: component.heading, text: component.text })

const effectiveSelection = (agentTitle: string, model: string | null, reasoningEffort: string | null) => ({
  agentTitle,
  modelSettings: { modelId: model, reasoningEffort },
})

const isContinuation = (entry: WaitingEntry) => entry.kind === "notification" && entry.trigger === "continuation"
const isForkAttach = (entry: WaitingEntry) => entry.kind === "notification" && entry.trigger === "fork"
const takeCause = (taken: ReadonlyArray<WaitingEntry>) =>
  isContinuation(taken[0]!) ? "continuation" : taken.some((entry) => entry.kind === "user") ? "user" : "notification"
const isContextInput = (entry: WaitingEntry) => entry.kind === "notification" && entry.trigger === "context"
const isIndependent = (entry: WaitingEntry) =>
  (entry.kind === "user" && entry.mode === "steer") || (entry.kind === "notification" && entry.trigger === "notification")

/**
 * Keeps every session's live state: its subscribers, its running turn, and
 * its permission requests. Events are persisted before they are sent, so
 * subscribers and later readers see the same numbered history; input
 * waiting for a turn is stored in the session's conversation state.
 */
export class SessionHub {
  private readonly states = new Map<string, SessionState>()
  readonly actions = new ActionBroker((sessionId, body) => this.emit(sessionId, body))
  private readonly now: () => number
  private readonly toolPolicy: ToolExecutionPolicy
  readonly attachments: AttachmentStore
  private stopping = false
  private readonly context: ContextTurns

  constructor(
    readonly store: SessionStore,
    private readonly options: HubOptions,
  ) {
    this.now = options.now ?? Date.now
    this.attachments = options.uploads ?? new AttachmentStore(store.db, options.uploadLimits)
    this.toolPolicy = options.toolPolicy ?? defaultToolPolicy()
    this.context = new ContextTurns(
      {
        store,
        files: options.files,
        now: () => this.now(),
        commit: (sessionId, write) => this.commit(sessionId, write),
        publish: (sessionId, files) => this.publish(sessionId, files),
        seedSources: (session, window) => this.laterSeedSources(session, window),
        trace: (sessionId) => this.traceOf(sessionId),
      },
      { port: options.port, models: options.models, auxiliaryModels: options.auxiliaryModels ?? {}, actions: this.actions },
    )
  }

  private get conversation() {
    return this.store.conversation
  }

  /** The trace context of the session's running turn, the parent of the spans of its work; else the active one. */
  private traceOf(sessionId: string): TraceContext {
    const live = this.states.get(sessionId)?.live
    return live === null || live === undefined ? otelContext.active() : withSpan(live.span)
  }

  private get fileState() {
    return this.store.files
  }

  private get files() {
    return this.options.files
  }

  /**
   * Ends every turn a stopped server left running: withdraws its
   * unanswered permission requests, gives each of its tool calls without a
   * result an interrupted one, as an item when an assistant item holds the
   * call, which for an `execute` call lists the tool calls its program had
   * finished, then emits its interrupted event, all in one transaction. A
   * turn that ended withdrew its own requests and answered its own calls,
   * so only running turns can hold unanswered ones.
   */
  recover() {
    for (const { sessionId, runId } of this.store.runningTurns()) {
      this.store.db.transaction(() => {
        const turn = this.store.getTurn(sessionId, runId)!
        const window = this.conversation.currentWindow(sessionId)!
        for (const requestId of this.openRequests(sessionId, runId)) {
          this.store.appendEvent(sessionId, { type: "PERMISSION_WITHDRAWN", requestId, reason: "restart" }, this.now())
        }
        const openModelCalls = new Map<string, string>()
        const committedCalls = new Set<string>()
        for (const { event } of this.turnEvents(sessionId, runId)) {
          if (event.type === "MODEL_CALL_STARTED") openModelCalls.set(event.modelCallId, event.runId)
          if (event.type === "MODEL_CALL_COMMITTED") committedCalls.add(event.modelCallId)
          if (event.type === "MODEL_CALL_COMMITTED" || event.type === "MODEL_CALL_DISCARDED") {
            openModelCalls.delete(event.modelCallId)
          }
        }
        for (const modelCallId of openModelCalls.keys()) {
          this.store.appendEvent(
            sessionId,
            { type: "MODEL_CALL_DISCARDED", runId, modelCallId, reason: "interrupted" },
            this.now(),
          )
        }
        for (const { modelCallId, toolCallId, name, invocationId, started, program } of this.unansweredCalls(sessionId, runId)) {
          const unfinished = unfinishedResult("interrupted", started)
          const content = program === null ? unfinished : `${unfinished} ${programCallsNote(program)}`
          if (!committedCalls.has(modelCallId)) continue
          this.conversation.appendToolResult(
            sessionId,
            window.position,
            { runId, model: turn.model, agentTitle: turn.agentTitle },
            { callId: toolCallId, name, content, outcome: "interrupted" },
            modelCallId,
            invocationId,
          )
          this.store.appendEvent(
            sessionId,
            {
              type: "TOOL_CALL_RESULT",
              modelCallId,
              messageId: crypto.randomUUID(),
              toolCallId,
              role: "tool",
              content,
              outcome: "interrupted",
              ...(invocationId === undefined ? {} : { invocationId }),
            },
            this.now(),
          )
        }
        this.store.endTurn(sessionId, runId, "interrupted", this.now())
        this.store.appendEvent(sessionId, { type: "RUN_INTERRUPTED", threadId: sessionId, runId }, this.now())
      })()
    }
  }

  /**
   * Settles what a stopped server left, before the hub serves, in order:
   * removes the files of sessions with no row, completes interrupted
   * memory publishes, attempts pending restores, settles the drafts of
   * context turns left running, records interrupted results, checks the
   * memory of every session without a pending restore, then starts turns
   * for waiting input in arrival order.
   */
  start() {
    this.files.sweep((id) => this.store.getSession(id) !== null)
    for (const { id } of this.store.sessions()) this.reportingFailure(id, "memory_publish_failed", () => this.completePublish(id))
    const failed = new Set(this.fileState.sessionsPendingRestore().filter((id) => !this.restoreIfPending(id)))
    this.context.settleAtStart()
    this.recover()
    for (const { id } of this.store.sessions()) {
      if (!failed.has(id)) this.reportingFailure(id, "memory_check_failed", () => this.checkMemory(id))
    }
    this.resumeWaiting(failed)
  }

  /** Runs `work` for the session, turning a failure into a session error event of `code`. */
  private reportingFailure(sessionId: string, code: string, work: () => void) {
    try {
      work()
    } catch (error) {
      const message = `${code === "memory_publish_failed" ? "completing the memory publish" : "checking memory"} failed: ${error instanceof Error ? error.message : String(error)}`
      try {
        this.commit(sessionId, (append) => append({ type: "SESSION_ERROR", code, message }))
      } catch {
        // Nothing more can be recorded; the next turn start checks memory again.
      }
    }
  }

  /**
   * Publishes `files` as the session's next memory generation: writes its
   * directory, records it as current, with `also` in the same transaction,
   * renames a new `memory` symlink over the old one, and removes the
   * session's other generation directories.
   */
  private publish(sessionId: string, files: ReadonlyArray<StoredFile>, also: () => void = () => {}) {
    traced("ashe_agent.memory_publish", {}, this.traceOf(sessionId), "memory_publish_failed", () => {
      const next = this.fileState.generations(sessionId).memory + 1
      const recorded = this.files.writeGeneration(sessionId, next, files)
      this.store.db.transaction(() => {
        this.fileState.recordGeneration(sessionId, next, recorded, this.now())
        also()
      })()
      this.completePublish(sessionId)
    })
  }

  /** Completes a publish a stop interrupted: points `memory` at the current generation and removes the others. */
  private completePublish(sessionId: string) {
    const current = this.fileState.generations(sessionId).memory
    if (current === 0) return
    this.files.pointMemory(sessionId, current)
    this.files.removeOtherGenerations(sessionId, current)
  }

  /** Stores a developer notification as waiting input, in a transaction the caller holds. */
  private queue(sessionId: string, component: Component, trigger: "notification" | "continuation" | "fork" = "notification") {
    const entry: NewWaitingEntry = { kind: "notification", inputId: crypto.randomUUID(), component, trigger }
    this.conversation.addWaiting(sessionId, entry, this.now())
  }

  /**
   * Checks the session's memory against its current generation and, on a
   * mismatch, republishes that generation, raises the memory restore
   * generation, and queues a memory restored component naming the paths
   * that differed.
   */
  private checkMemory(sessionId: string) {
    traced("ashe_agent.memory_check", {}, this.traceOf(sessionId), "memory_check_failed", () => {
      const generations = this.fileState.generations(sessionId)
      const recorded = this.fileState.generationFiles(sessionId, generations.memory)
      const check = this.files.checkMemory(sessionId, generations.memory, recorded)
      if (check.ok) return
      const restore = generations.memoryRestore + 1
      this.publish(sessionId, this.fileState.files(recorded), () => {
        this.fileState.setGenerations(sessionId, { memoryRestore: restore })
        this.queue(sessionId, memoryRestored(restore, check.paths))
      })
    })
  }

  /** Recreates a lost scratch target, raising the scratch generation and queuing a scratch lost component. */
  private checkScratch(sessionId: string) {
    if (!this.files.ensureScratch(sessionId)) return
    this.store.db.transaction(() => {
      const scratch = this.fileState.generations(sessionId).scratch + 1
      this.fileState.setGenerations(sessionId, { scratch })
      this.queue(sessionId, scratchLost(scratch, false))
    })()
  }

  /**
   * Queues, in a transaction the caller holds, the reconciled
   * notifications a rewind or fork leaves due: scratch lost and memory
   * restored, without paths, when the session's generation exceeds the one
   * the current checkpoint window knows.
   */
  private queueReconciledNotifications(sessionId: string, trigger: "notification" | "fork" = "notification") {
    const generations = this.fileState.generations(sessionId)
    const known = this.conversation.knownStates(sessionId, this.conversation.currentWindow(sessionId)!.position)
    if (generations.scratch > (known.scratchGeneration ?? 0)) this.queue(sessionId, scratchLost(generations.scratch, true), trigger)
    if (generations.memoryRestore > (known.memoryRestoreGeneration ?? 0)) {
      this.queue(sessionId, memoryRestored(generations.memoryRestore, null), trigger)
    }
  }

  /**
   * Completes the session's pending restore, if it has one: writes back its
   * research files, publishes its memory files as the next generation,
   * which drops the restore, and deletes the stored contents nothing
   * references. Returns whether no restore is pending; a failed one stays
   * pending and emits a session error event.
   */
  private restoreIfPending(sessionId: string): boolean {
    const refs = this.fileState.pendingRestore(sessionId)
    if (refs === null) return true
    try {
      traced("ashe_agent.restore", {}, this.traceOf(sessionId), "restore_failed", () => {
        this.files.writeResearch(sessionId, this.fileState.files(refs.filter((ref) => ref.area === "research")))
        this.publish(sessionId, this.fileState.files(refs.filter((ref) => ref.area === "memory")))
        // Only a complete publish drops the restore; one that failed after its commit is redone.
        this.store.db.transaction(() => {
          this.fileState.deletePendingRestore(sessionId)
          this.fileState.deleteUnreferencedContents()
        })()
      })
      return true
    } catch (error) {
      const message = `the rewind's restore of research and memory files failed and stays pending: ${error instanceof Error ? error.message : String(error)}`
      try {
        this.commit(sessionId, (append) => append({ type: "SESSION_ERROR", code: "restore_failed", message }))
      } catch {
        // The restore stays pending either way; the next request or server start tries again.
      }
      return false
    }
  }

  /** The research files of the session now and the files of its current memory generation, as a snapshot records them. */
  private currentFiles(sessionId: string): { readonly research: ReadonlyArray<StoredFile>; readonly refs: ReadonlyArray<FileRef> } {
    return traced("ashe_agent.snapshot", {}, this.traceOf(sessionId), "snapshot_failed", () => {
      const research = this.files.readResearch(sessionId)
      const memory = this.fileState.generationFiles(sessionId, this.fileState.generations(sessionId).memory)
      return {
        research,
        refs: [
          ...research.map((file) => ({ area: "research" as const, name: file.name, sha256: file.sha256 })),
          ...memory.map((file) => ({ area: "memory" as const, name: file.name, sha256: file.sha256 })),
        ],
      }
    })
  }

  /**
   * Starts turns for the input left waiting at a server stop, in arrival
   * order, once recovery is done; sessions in `skip`, whose restore just
   * failed, wait for a later request.
   */
  resumeWaiting(skip: ReadonlySet<string> = new Set()) {
    for (const sessionId of this.conversation.sessionsWaiting()) if (!skip.has(sessionId)) this.startNext(sessionId)
  }

  /** The events of the turn `runId`, from its input on. */
  private turnEvents(sessionId: string, runId: string) {
    const turn = this.store.getTurn(sessionId, runId)!
    return this.store.eventsAfter(sessionId, turn.firstSeq - 1)
  }

  /** The permission requests of the turn `runId` that are neither resolved nor withdrawn. */
  private openRequests(sessionId: string, runId: string): ReadonlyArray<string> {
    const open = new Set<string>()
    for (const { event } of this.turnEvents(sessionId, runId)) {
      if (event.type === "PERMISSION_REQUESTED" && event.runId === runId) open.add(event.requestId)
      if (event.type === "PERMISSION_RESOLVED" || event.type === "PERMISSION_WITHDRAWN") open.delete(event.requestId)
    }
    return [...open]
  }

  /** The tool calls the turn `runId` started streaming that have no result, with whether each started running. */
  private unansweredCalls(sessionId: string, runId: string) {
    type Call = {
      modelCallId: string
      toolCallId: string
      name: string
      invocationId?: string
      started: boolean
      program: Array<{ tool: string; outcome: string }> | null
    }
    const calls: Array<Call> = []
    const byInvocation = new Map<string, Call>()
    const find = (modelCallId: string, toolCallId: string, invocationId?: string) =>
      (invocationId === undefined ? undefined : byInvocation.get(invocationId)) ??
      calls.find((call) => call.modelCallId === modelCallId && call.toolCallId === toolCallId)
    const remove = (call: Call) => {
      const index = calls.indexOf(call)
      if (index >= 0) calls.splice(index, 1)
      if (call.invocationId !== undefined) byInvocation.delete(call.invocationId)
    }
    for (const { event } of this.turnEvents(sessionId, runId)) {
      if (event.type === "TOOL_CALL_START") {
        const call = {
          modelCallId: event.modelCallId,
          toolCallId: event.toolCallId,
          name: event.toolCallName,
          ...(event.invocationId === undefined ? {} : { invocationId: event.invocationId }),
          started: false,
          program: event.toolCallName === "execute" ? [] : null,
        }
        calls.push(call)
        if (call.invocationId !== undefined) byInvocation.set(call.invocationId, call)
      }
      if (event.type === "PROGRAM_CALL_FINISHED") {
        find(event.modelCallId, event.toolCallId)?.program?.push({ tool: event.tool, outcome: event.outcome })
      }
      if (event.type === "TOOL_EXECUTION_STARTED") {
        const call = find(event.modelCallId, event.toolCallId, event.invocationId)
        if (call !== undefined) call.started = true
      }
      if (event.type === "TOOL_CALL_RESULT") {
        const call = find(event.modelCallId, event.toolCallId, event.invocationId)
        if (call !== undefined) remove(call)
      }
    }
    const used = new Set(calls.flatMap((call) => (call.invocationId === undefined ? [] : [call.invocationId])))
    const rows = this.store.db
      .query<{ entry_id: string; model_call_id: string; provider_call_id: string | null }, [string, string]>(
        `SELECT a.entry_id, a.model_call_id, a.provider_call_id FROM agent_tools a
          JOIN session_entries e ON e.session_id = a.session_id AND e.entry_id = a.entry_id
          WHERE a.session_id = ? AND e.owner_turn_id = ? AND a.settled_at IS NULL
          ORDER BY e.position`,
      )
      .all(sessionId, runId)
    for (const call of calls) {
      if (call.invocationId !== undefined) continue
      const row = rows.find(
        (candidate) =>
          candidate.model_call_id === call.modelCallId &&
          candidate.provider_call_id === call.toolCallId &&
          !used.has(candidate.entry_id),
      )
      if (row === undefined) continue
      call.invocationId = row.entry_id
      used.add(row.entry_id)
    }
    return calls
  }

  private state(sessionId: string): SessionState {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      state = { listeners: new Set(), live: null, controlled: false, settled: null, asks: new Map() }
      this.states.set(sessionId, state)
    }
    return state
  }


  /** The rules deciding a session's calls: global, then its agent's, then its grants as allow rules. */
  rules(session: SessionRecord): ReadonlyArray<Rule> {
    return this.rulesForTurn(session, session.agent ?? UNTITLED_AGENT_TITLE)
  }

  /** The rules one AgentTurn keeps for its whole run, with grants from its applied title. */
  private rulesForTurn(session: SessionRecord, agentTitle: string): ReadonlyArray<Rule> {
    return this.rulesOf(session.permission, this.store.grants(session.id, agentTitle))
  }

  private rulesOf(agent: Permission | null, grants: ReturnType<SessionStore["grants"]>): ReadonlyArray<Rule> {
    const home = this.options.home ?? "/"
    return [
      ...compileRules(this.options.permission ?? {}, home),
      ...(agent === null ? [] : compileRules(agent, home)),
      ...grants.map((grant) => ({ ...grant, action: "allow" as const })),
    ]
  }

  private authorize(
    sessionId: string,
    runId: string,
    agentTitle: string,
    rules: ReadonlyArray<Rule>,
    toolCallId: string,
    check: PermissionCheck,
    signal: AbortSignal,
  ) {
    const decision = decide(rules, check)
    if (decision.action === "allow") return Promise.resolve()
    if (decision.action === "deny") return Promise.reject(new PermissionDenied(decision.denied))
    signal.throwIfAborted()
    const asks = this.state(sessionId).asks
    const requestId = crypto.randomUUID()
    return new Promise<void>((resolve, reject) => {
      const ask: Ask = {
        runId,
        agentTitle,
        rules,
        check,
        actionId: null,
        settle: (outcome) => {
          signal.removeEventListener("abort", onAbort)
          asks.delete(requestId)
          if (outcome.kind === "allowed") resolve()
          else reject(new PermissionRejected(outcome.message))
        },
        fail: (error) => {
          signal.removeEventListener("abort", onAbort)
          asks.delete(requestId)
          reject(error)
        },
      }
      const onAbort = () => {
        asks.delete(requestId)
        try {
          this.emit(sessionId, {
            type: "PERMISSION_WITHDRAWN",
            requestId,
            reason: this.stopping ? "restart" : "canceled",
          })
        } catch (error) {
          reject(error instanceof IntegrityFailure ? error : new IntegrityFailure(`the permission withdrawal could not be recorded: ${errorText(error)}`))
          return
        }
        reject(signal.reason)
      }
      asks.set(requestId, ask)
      signal.addEventListener("abort", onAbort, { once: true })
      try {
        this.emit(sessionId, {
          type: "PERMISSION_REQUESTED",
          requestId,
          runId,
          toolCallId,
          permission: check.permission,
          subjects: [...decision.asked],
          patterns: [...check.patterns],
        })
      } catch (error) {
        ask.fail(error instanceof IntegrityFailure ? error : new IntegrityFailure(`the permission request could not be recorded: ${errorText(error)}`))
        return
      }
      try {
        const action = this.actions.run<PermissionActionResult>(
          PERMISSION_ACTION,
          { requestId, permission: check.permission, subjects: [...decision.asked], patterns: [...check.patterns] },
          { sessionId, clock: this.toolPolicy.clock, signal, onAssigned: (id) => (ask.actionId = id) },
        )
        void action.then(
          (outcome) => {
            try {
              this.answer(sessionId, requestId, outcome.result.answer, outcome.result.message, outcome.principal)
            } catch (error) {
              if (asks.get(requestId) !== ask) return
              try {
                this.emit(sessionId, {
                  type: "PERMISSION_WITHDRAWN",
                  requestId,
                  reason: this.stopping ? "restart" : "canceled",
                })
              } catch (emitError) {
                ask.fail(emitError instanceof Error ? emitError : new IntegrityFailure(errorText(emitError)))
                return
              }
              ask.fail(
                error instanceof IntegrityFailure
                  ? error
                  : new IntegrityFailure(`the permission decision could not be recorded: ${errorText(error)}`),
              )
            }
          },
          (error: unknown) => {
            if (asks.get(requestId) !== ask) return
            asks.delete(requestId)
            try {
              this.emit(sessionId, {
                type: "PERMISSION_WITHDRAWN",
                requestId,
                reason: this.stopping ? "restart" : "canceled",
              })
            } catch (emitError) {
              ask.fail(emitError instanceof IntegrityFailure ? emitError : new IntegrityFailure(`the permission withdrawal could not be recorded: ${errorText(emitError)}`))
              return
            }
            ask.fail(error instanceof IntegrityFailure ? error : new PermissionCollectionUnavailable(errorText(error)))
          },
        )
      } catch (error) {
        asks.delete(requestId)
        try {
          this.emit(sessionId, {
            type: "PERMISSION_WITHDRAWN",
            requestId,
            reason: this.stopping ? "restart" : "canceled",
          })
        } catch (emitError) {
          ask.fail(emitError instanceof IntegrityFailure ? emitError : new IntegrityFailure(`the permission withdrawal could not be recorded: ${errorText(emitError)}`))
          return
        }
        ask.fail(error instanceof IntegrityFailure ? error : new PermissionCollectionUnavailable(errorText(error)))
      }
    })
  }

  /**
   * Answers a pending permission request. `always` grants the request's
   * patterns for the rest of the session and approves the session's other
   * requests the grant now allows; `reject` rejects every other pending
   * request of the session with the same message.
   */
  answer(sessionId: string, requestId: string, answer: "once" | "always" | "reject", message: string | undefined, sender: Sender) {
    this.session(sessionId)
    const asks = this.state(sessionId).asks
    const ask = asks.get(requestId)
    if (ask === undefined) {
      const known = this.store
        .eventsAfter(sessionId, 0)
        .some(({ event }) => event.type === "PERMISSION_REQUESTED" && event.requestId === requestId)
      throw known
        ? new ProtocolError({ code: ErrorCode.alreadyResolved, message: `request ${requestId} is already resolved` })
        : notFound(`permission request ${requestId}`)
    }
    const resolved = (id: string, by: "once" | "always" | "reject", from?: Sender) =>
      this.emit(sessionId, {
        type: "PERMISSION_RESOLVED",
        requestId: id,
        answer: by,
        ...(by === "reject" && message !== undefined ? { message } : {}),
        ...(from === undefined ? {} : { sender: from }),
      })
    if (answer === "reject") {
      const others = [...asks.entries()].filter(([id]) => id !== requestId)
      resolved(requestId, "reject", sender)
      ask.settle({ kind: "rejected", message })
      for (const [id, other] of others) {
        if (other.actionId !== null) this.actions.cancel(other.actionId, "rejected with another pending permission request")
        resolved(id, "reject")
        other.settle({ kind: "rejected", message })
      }
      return
    }
    if (answer === "always") {
      this.store.addGrants(sessionId, ask.agentTitle, ask.check.permission, ask.check.patterns)
    }
    resolved(requestId, answer, sender)
    ask.settle({ kind: "allowed" })
    if (answer !== "always") return
    const granted = [
      ...ask.rules,
      ...ask.check.patterns.map((pattern) => ({
        permission: ask.check.permission,
        pattern,
        action: "allow" as const,
      })),
    ]
    for (const [id, other] of [...asks.entries()]) {
      if (decide(granted, other.check).action !== "allow") continue
      if (other.actionId !== null) this.actions.cancel(other.actionId, "allowed by another permission grant")
      resolved(id, "always")
      other.settle({ kind: "allowed" })
    }
  }

  private session(sessionId: string): SessionRecord {
    const session = this.store.getSession(sessionId)
    if (session === null) throw notFound(`session ${sessionId}`)
    return session
  }

  private emit(sessionId: string, body: SessionEventBody): SessionEvent {
    return this.commit(sessionId, (append) => append(body))
  }

  /**
   * Runs `write` in one transaction and sends the events it appended to
   * the session's subscribers once it commits; a failure sends none.
   */
  private commit<A>(sessionId: string, write: (append: (body: SessionEventBody) => SessionEvent) => A): A {
    const appended: Array<SessionEvent> = []
    let result: A
    try {
      result = this.store.db.transaction(() =>
        write((body) => {
          const event = this.store.appendEvent(sessionId, body, this.now())
          appended.push(event)
          return event
        }),
      )()
    } catch (error) {
      if (error instanceof ProtocolError || error instanceof IntegrityFailure || error instanceof AttachmentError) throw error
      throw new IntegrityFailure(`the session state transaction failed: ${errorText(error)}`)
    }
    const listeners = this.state(sessionId).listeners
    for (const event of appended) for (const listener of listeners) listener(event)
    return result
  }

  isRunning(sessionId: string) {
    return this.states.get(sessionId)?.live != null
  }

  /** The configured models as clients list them, and the default one. */
  models(): { readonly models: ReadonlyArray<Model>; readonly defaultModel: string } {
    return {
      models: this.options.models.map((model) => ({
        id: model.id,
        name: model.name,
        contextLimit: model.contextLimit,
        imageInput: model.imageInput,
        pdfInput: model.pdfInput,
        reasoningEfforts: [...model.efforts],
        reasoningEffort: model.settings.reasoningEffort ?? null,
      })),
      defaultModel: this.options.defaultModel,
    }
  }

  private model(id: string): ConfiguredModel {
    const model = this.options.models.find((candidate) => candidate.id === id)
    if (model === undefined) throw invalid(`no configured model ${id}`)
    return model
  }

  /** `effort` when `model` lists it; refused otherwise. */
  private effort(model: ConfiguredModel, effort: string | undefined): string | null {
    if (effort === undefined) return null
    if (!model.efforts.includes(effort)) throw invalid(`the model ${model.id} lists no reasoning effort ${effort}`)
    return effort
  }


  list(): ReadonlyArray<SessionSummary> {
    return this.store.listSessions((id) => this.activeTurn(id))
  }

  summary(sessionId: string): SessionSummary {
    return this.store.summary(this.session(sessionId), this.activeTurn(sessionId))
  }

  private activeTurn(sessionId: string): TurnRecord | null {
    return this.states.get(sessionId)?.live?.turn ?? null
  }


  /**
   * The tools `rules` leave offered: every available tool and `context`
   * tool they do not wholly deny, and `context_append` and
   * `context_get_open_items` under any rules.
   */
  private offeredTools(rules: ReadonlyArray<Rule>, sessionId?: string): ReadonlyArray<Tool> {
    return [...(this.options.tools?.() ?? []), ...this.context.tools].filter((tool) => {
      if (!UNCHECKED_CONTEXT_TOOLS.includes(tool.spec.name) && whollyDenied(rules, withholdingName(tool))) return false
      return tool.actions === undefined || (sessionId !== undefined && tool.actions.every((name) => this.actions.available(sessionId, name)))
    })
  }

  /** The user instructions the checkpoint window `window` knows, with their stored text, or null when it knows none. */
  private knownInstructions(sessionId: string, window: number): UserInstructions | null {
    const known = this.conversation.knownStates(sessionId, window).userInstructions
    if (known === undefined || known.kind === "none") return null
    const text = this.conversation.content(known.sha256)
    return text === null ? null : { source: known.kind, path: known.path, text, sha256: known.sha256, metadata: known.metadata }
  }

  /**
   * The seed sources of a construction after a context turn in the
   * checkpoint window `window`, read now; user instructions that cannot be
   * read keep those `window` knows, with an error saying so.
   */
  private laterSeedSources(session: SessionRecord, window: number) {
    const errors: Array<{ readonly code: string; readonly message: string }> = []
    const agent: SessionAgent = { key: session.agent, model: null, overrides: session.modelOverrides, permission: session.permission }
    let instructions: UserInstructions | null
    try {
      const read = this.options.setup.userInstructions(agent)
      instructions = read === "unchanged" ? this.knownInstructions(session.id, window) : read
    } catch (error) {
      if (!(error instanceof InstructionsUnreadable)) throw error
      errors.push({ code: "user_instructions_unreadable", message: `${error.message}; the known user instructions stay` })
      instructions = this.knownInstructions(session.id, window)
    }
    const generations = this.fileState.generations(session.id)
    return {
      sources: {
        harness: harnessInstructions(this.store.sessionsDir),
        instructions,
        title: session.agent === null ? null : displayTitle(session.agent),
        catalogs: this.options.setup.catalogs(this.rules(session)),
        sessionId: session.id,
        dates: this.dates(),
        scratchGeneration: generations.scratch,
        memoryRestoreGeneration: generations.memoryRestore,
      },
      errors,
    }
  }

  private dates() {
    return currentDates(this.now(), this.options.userTimeZone ?? "UTC", this.options.serverTimeZone)
  }

  private configuredAgent(title: string): SessionAgent | null {
    if (title === UNTITLED_AGENT_TITLE) return { key: null, model: null, overrides: {}, permission: null }
    try {
      return this.options.setup.resolve(title)
    } catch {
      return null
    }
  }

  private selectionFailure(turn: TurnRecord): { readonly message: string; readonly code: string } | undefined {
    if (turn.agentTitle !== UNTITLED_AGENT_TITLE && this.configuredAgent(turn.agentTitle) === null) {
      return { message: `the title ${turn.agentTitle} is not configured`, code: "title_unavailable" }
    }
    if (turn.model === null) return { message: "the session has no model selected", code: "model_unavailable" }
    const model = this.options.models.find((candidate) => candidate.id === turn.model)
    if (model === undefined) return { message: `the model ${turn.model} is not configured`, code: "model_unavailable" }
    if (turn.reasoningEffort !== null && !model.efforts.includes(turn.reasoningEffort)) {
      return {
        message: `the model ${model.id} does not support the reasoning effort ${turn.reasoningEffort}`,
        code: "reasoning_effort_unavailable",
      }
    }
    return undefined
  }

  private compatibleEffort(effort: string | null, modelId: string | null): string | null {
    if (effort === null || modelId === null) return null
    const model = this.options.models.find((candidate) => candidate.id === modelId)
    return model === undefined || model.efforts.includes(effort) ? effort : null
  }

  private nextAdmissionProfile(current: AgentProfile, patch: SelectionPatch): AgentProfile {
    let title = current.agentTitle
    let modelId = current.modelSettings.modelId
    let effort = current.modelSettings.reasoningEffort
    if (patch.agentTitle !== undefined) {
      title = patch.agentTitle
      const listing = this.options.setup.agents().agents.find((agent) => agent.key === title)
      const explicitModel = patch.modelSettings?.modelId
      if (title === UNTITLED_AGENT_TITLE) {
        modelId = explicitModel === undefined ? this.options.defaultModel : explicitModel
        effort = null
      } else if (listing !== undefined) {
        modelId = explicitModel === undefined ? (listing.model ?? this.options.defaultModel) : explicitModel
        effort =
          (modelId === null ? undefined : listing.reasoningEfforts[modelId]) ??
          this.compatibleEffort(effort, modelId)
      } else {
        modelId = explicitModel === undefined ? null : explicitModel
        effort = this.compatibleEffort(effort, modelId)
      }
    }
    if (patch.modelSettings?.modelId !== undefined && patch.agentTitle === undefined) {
      modelId = patch.modelSettings.modelId
      effort = this.compatibleEffort(effort, modelId)
    }
    if (patch.modelSettings?.reasoningEffort !== undefined) effort = patch.modelSettings.reasoningEffort
    return { agentTitle: title, modelSettings: { modelId, reasoningEffort: effort } }
  }

  private admissionSelection(session: SessionRecord, taken: ReadonlyArray<WaitingEntry>) {
    let profile: AgentProfile = {
      agentTitle: session.agent ?? UNTITLED_AGENT_TITLE,
      modelSettings: { modelId: session.model, reasoningEffort: session.reasoningEffort },
    }
    const steps: Array<{ readonly inputId: string; readonly profile: AgentProfile; readonly before: AgentProfile }> = []
    for (const entry of taken) {
      if (entry.kind !== "user" || entry.selection === undefined) continue
      const before = profile
      profile = this.nextAdmissionProfile(profile, entry.selection)
      steps.push({ inputId: entry.inputId, profile, before })
    }
    const agent = this.configuredAgent(profile.agentTitle)
    const effective: SessionRecord = {
      ...session,
      agent: profile.agentTitle === UNTITLED_AGENT_TITLE ? null : profile.agentTitle,
      model: profile.modelSettings.modelId,
      reasoningEffort: profile.modelSettings.reasoningEffort,
      modelOverrides: agent?.overrides ?? {},
      permission: agent?.permission ?? null,
    }
    return { profile, steps, effective }
  }

  /** A new session id that no session and no directory has. */
  private newSessionId() {
    for (;;) {
      const id = randomSessionId()
      if (this.store.getSession(id) === null) return id
    }
  }

  /**
   * Creates a session in its own new directory, running as `agent`, else
   * the default agent, else the implicit agent. Its model is the one its
   * agent names, else the one given, else the default model, and it starts
   * with the given reasoning effort, which that model must list. Its first
   * checkpoint window is constructed with it; a seed component or the tool
   * definitions over their allowance, or user instructions that cannot be
   * read, fail the creation.
   */
  create(params: { model?: string | null; agent?: string; reasoningEffort?: string | null }): SessionSummary {
    const agent =
      params.agent === UNTITLED_AGENT_TITLE
        ? { key: null, model: null, overrides: {}, permission: null }
        : this.options.setup.resolve(params.agent ?? null)
    const selected = params.model !== undefined ? params.model : (agent.model ?? this.options.defaultModel)
    const model = selected === null ? null : this.model(selected)
    const title =
      agent.key === null
        ? undefined
        : this.options.setup.agents().agents.find((candidate) => candidate.key === agent.key)
    const effort =
      params.reasoningEffort !== undefined
        ? params.reasoningEffort
        : model === null
          ? undefined
          : title?.reasoningEfforts[model.id]
    if (model === null && effort != null) {
      throw invalid("a session without a model cannot select a reasoning effort")
    }
    const reasoningEffort = model === null || effort === null ? null : this.effort(model, effort)
    const id = this.newSessionId()
    const rules = this.rulesOf(agent.permission, [])
    const harness = harnessInstructions(this.store.sessionsDir)
    const cause = { "ashe_agent.checkpoint_window.cause": "creation" } as const
    let unreadable: unknown = null
    const failure = (error: unknown) => (error === unreadable ? "user_instructions_unreadable" : "checkpoint_window_failed")
    const { instructions, seed } = traced("ashe_agent.checkpoint_window_construction", cause, otelContext.active(), failure, () => {
      let instructions: UserInstructions | null
      try {
        const read = this.options.setup.userInstructions(agent)
        instructions = read === "unchanged" ? null : read
      } catch (error) {
        unreadable = invalid(error instanceof Error ? error.message : String(error))
        throw unreadable
      }
      const seed = renderSeed({
        harness,
        instructions,
        title: agent.key === null ? null : displayTitle(agent.key),
        catalogs: this.options.setup.catalogs(rules),
        sessionId: id,
        dates: this.dates(),
        scratchGeneration: 0,
        memoryRestoreGeneration: 0,
        tools: this.offeredTools(rules, id).map((tool) => tool.spec),
      })
      if (!seed.ok) throw invalid(`the session's first checkpoint window cannot be built: ${allowanceMessage(seed.issue)}`)
      return { instructions, seed }
    })
    const createdAt = this.now()
    this.withSessionFiles(id, () => {
      const memory = this.options.files.writeGeneration(id, 1, [])
      this.options.files.pointMemory(id, 1)
      this.store.db.transaction(() => {
        this.store.createSession(
          {
            id,
            agent: agent.key,
            model: model?.id ?? null,
            reasoningEffort,
            modelOverrides: agent.overrides,
            permission: agent.permission,
            createdAt,
          },
          null,
        )
        this.fileState.recordGeneration(id, 1, memory, createdAt)
        if (instructions !== null) this.conversation.putContent(instructions.sha256, instructions.text)
        const window = this.conversation.insertWindow(id, null, harness, createdAt)
        for (const component of seed.components) this.conversation.appendItem(id, window.position, null, { kind: "component", component })
        this.store.appendEvent(
          id,
          { type: "CHECKPOINT_WINDOW_SEEDED", runId: null, window: window.position, components: seed.components.map(wire) },
          createdAt,
        )
      })()
    })
    recordDuration("ashe_agent.checkpoint_window.size", seedTokens(harness, seed.components), cause)
    return this.summary(id)
  }

  /**
   * Creates the files of a new session, its directory with `research/`,
   * its memory directory, and its scratch target, readable by the server's
   * user only, then runs `make`, which writes its first memory generation
   * and records the session; when `make` fails, exactly the files this
   * attempt created are removed.
   */
  private withSessionFiles<A>(id: string, make: () => A): A {
    const remove = this.options.files.createLayout(id)
    try {
      return make()
    } catch (error) {
      remove()
      throw error
    }
  }

  /**
   * Sends the session's persisted events after `afterSeq`, then every live
   * event, to `listener`. Both happen in one synchronous step, so no event
   * is missed or repeated. Returns the unsubscribe function.
   */
  subscribe(sessionId: string, afterSeq: number, listener: Listener): () => void {
    this.session(sessionId)
    for (const event of this.store.eventsAfter(sessionId, afterSeq)) listener(event)
    const listeners = this.state(sessionId).listeners
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /** The configured agents, each with its title, title file state, and settings, and the default agent. */
  agents() {
    const configured = this.options.setup.agents()
    return {
      agents: [
        {
          key: UNTITLED_AGENT_TITLE,
          title: displayTitle(UNTITLED_AGENT_TITLE),
          description: null,
          model: this.options.defaultModel,
          reasoningEfforts: {},
          titleFile: { state: "absent" as const },
        },
        ...configured.agents,
      ],
      defaultAgent: configured.defaultAgent,
    }
  }

  /**
   * Takes a user message: it is stored as waiting input, then starts a turn
   * on an idle session. Waiting, a steered message is admitted as a new turn
   * at the running turn's next complete step, and a queued one starts a turn
   * after it ends; messages of each lane enter in arrival order.
   */
  input(
    sessionId: string,
    text: string,
    mode: InputMode | undefined,
    sender: Sender,
    options: { readonly selection?: SelectionPatch; readonly attachments?: ReadonlyArray<RetainedAttachmentRef> } = {},
  ): string {
    this.session(sessionId)
    if (this.stopping) throw conflict("the server is stopping")
    if (this.state(sessionId).controlled) throw conflict("the session's history is being changed")
    const inputId = crypto.randomUUID()
    const entry = {
      kind: "user" as const,
      inputId,
      text,
      mode: mode ?? "steer",
      sender,
      ...(options.selection === undefined ? {} : { selection: options.selection }),
      ...(options.attachments === undefined || options.attachments.length === 0 ? {} : { attachments: options.attachments }),
    }
    this.commit(sessionId, (append) => {
      if (options.attachments !== undefined && options.attachments.length > 0) {
        this.attachments.claim(senderOwner(sender), sessionId, inputId, options.attachments, this.now())
      }
      this.conversation.addWaiting(sessionId, entry, this.now())
      append({ type: "INPUT_WAITING", inputId, text, mode: entry.mode, sender })
    })
    this.startNext(sessionId)
    return inputId
  }

  cancel(sessionId: string) {
    this.session(sessionId)
    const live = this.state(sessionId).live
    if (live === null) throw conflict("no turn is running")
    live.cancelled = true
    Effect.runFork(Fiber.interrupt(live.fiber))
  }

  /** Starts an idle session with continuation content, which joins its next eligible batch. */
  resume(sessionId: string) {
    this.session(sessionId)
    if (this.state(sessionId).controlled) throw conflict("the session's history is being changed")
    if (this.state(sessionId).live !== null) throw conflict("the session is already running")
    if (this.context.activeWorkflow(sessionId) !== null) throw conflict("the session's context workflow is active")
    if (this.conversation.waiting(sessionId).some(isContinuation)) throw conflict("a continuation is already pending")
    this.commit(sessionId, () => this.queue(sessionId, continuationComponent({}), "continuation"))
    this.startNext(sessionId)
  }


  /**
   * Starts a turn on an idle session with one finite batch from the eligible
   * lane: steering and independently triggering notifications, in arrival
   * order, otherwise queued input. A continuation joins that batch, or is
   * admitted alone. Fork reconciliation is attach-only. A pending restore is
   * completed first, and a session whose restore fails starts no turn. The
   * turn start checks scratch and memory, which may queue notifications, and
   * snapshots the research and memory files. When the turn cannot start, its
   * input stays waiting for the next start, and a session error event says
   * why.
   */
  private startNext(sessionId: string) {
    const state = this.state(sessionId)
    if (this.stopping || state.controlled || state.live !== null) return
    if (this.conversation.waiting(sessionId).length === 0) return
    if (!this.restoreIfPending(sessionId)) return
    try {
      this.checkScratch(sessionId)
      this.checkMemory(sessionId)
      const waiting = this.conversation.waiting(sessionId)
      const workflow = this.context.activeWorkflow(sessionId)
      if (workflow !== null) {
        const own = waiting.filter(
          (entry) => entry.kind === "notification" && entry.trigger === "context" && entry.workflowId === workflow.id,
        )
        if (own.length === 0) return
        const memory = waiting.filter(
          (entry) => entry.kind === "notification" && entry.component.name === "memory_restored",
        )
        const selected = new Set([...own, ...memory])
        this.startTurn(sessionId, waiting.filter((entry) => selected.has(entry)), this.currentFiles(sessionId))
        return
      }
      const continuation = waiting.find(isContinuation)
      const steering = waiting.filter(isIndependent)
      const queued = waiting.filter((entry) => entry.kind === "user" && entry.mode === "queue")
      const selected = steering.length > 0 ? steering : queued
      const context = waiting.filter(isContextInput)
      const base = selected.length > 0 ? selected : context
      if (base.length === 0 && continuation === undefined) return
      const trigger = base.length > 0 ? new Set(base) : new Set([continuation!])
      const taken = [
        ...(continuation === undefined ? [] : [continuation]),
        ...waiting.filter((entry) => trigger.has(entry) || isForkAttach(entry)),
      ]
      this.startTurn(sessionId, taken, this.currentFiles(sessionId))
    } catch (error) {
      const message = `the turn could not start, and its input stays waiting: ${error instanceof Error ? error.message : String(error)}`
      try {
        this.commit(sessionId, (append) => append({ type: "SESSION_ERROR", code: "turn_start_failed", message }))
      } catch {
        // The input stays waiting either way; the next input or server start tries again.
      }
    }
  }

  /**
   * The state components a delivery carries, one per source whose current
   * state differs from what the session's current checkpoint window knows,
   * and the errors of sources that cannot be read or are over allowance.
   */
  private reconcile(session: SessionRecord, known: SourceStates) {
    return traced("ashe_agent.reconciliation", {}, this.traceOf(session.id), "internal", (notes) => {
      const reconciled = this.reconcileSources(session, known)
      if (reconciled.errors.some((error) => error.code === "user_instructions_unreadable")) notes.fail("user_instructions_unreadable")
      return reconciled
    })
  }

  private reconcileSources(session: SessionRecord, known: SourceStates) {
    const components: Array<Component> = []
    const errors: Array<{ readonly code: string; readonly message: string }> = []
    const title = session.agent === null ? null : displayTitle(session.agent)
    const agent: SessionAgent = { key: session.agent, model: null, overrides: session.modelOverrides, permission: session.permission }
    const knownInstructions = known.userInstructions ?? { kind: "none" as const }
    try {
      const read = this.options.setup.userInstructions(
        agent,
        knownInstructions.kind === "none" ? undefined : { path: knownInstructions.path, metadata: knownInstructions.metadata },
      )
      if (read !== "unchanged") {
        const knownText = knownInstructions.kind === "none" ? null : this.conversation.content(knownInstructions.sha256)
        const change = instructionsChange(knownInstructions, knownText, read, title)
        if (change !== null) {
          if (read !== null) this.conversation.putContent(read.sha256, read.text)
          components.push(change)
        }
      }
    } catch (error) {
      if (!(error instanceof InstructionsUnreadable)) throw error
      errors.push({ code: "user_instructions_unreadable", message: `${error.message}; the known user instructions stay` })
    }
    const catalogs = catalogChanges(
      { skills: known.skillCatalog?.text ?? null, codeMode: known.codeModeCatalog?.text ?? null },
      this.options.setup.catalogs(this.rules(session)),
    )
    components.push(...catalogs.components)
    for (const issue of catalogs.issues) {
      errors.push({ code: "catalog_over_allowance", message: `${allowanceMessage(issue)}; the known catalog stays` })
    }
    const dates = this.dates()
    if (known.dates === undefined || !sameDates(known.dates, dates)) components.push(datesChanged(dates))
    if (known.identity?.sessionId !== session.id) {
      components.push(forkComponent(known.identity?.sessionId ?? session.id, session.id, this.fileState.generations(session.id).forkSkipped))
    }
    return { components, errors }
  }

  /**
   * Assembles the admitted batch before the admission transaction: the
   * waiting entries in arrival order, with the state components
   * reconciliation yields before the first user message. A fork component
   * stays immediately before the fork-caused notifications it explains.
   */
  private assembleDelivery(sessionId: string, taken: ReadonlyArray<WaitingEntry>, session = this.session(sessionId)) {
    const window = this.conversation.currentWindow(sessionId)!
    const { components: state, errors } = this.reconcile(session, this.conversation.knownStates(sessionId, window.position))
    type Delivered =
      | { readonly kind: "component"; readonly inputId: string; readonly component: Component }
      | { readonly kind: "user"; readonly inputId: string; readonly entry: Extract<WaitingEntry, { kind: "user" }> }
    const delivered: Array<Delivered> = taken.map((entry) =>
      entry.kind === "user"
        ? { kind: "user", inputId: entry.inputId, entry }
        : { kind: "component", inputId: entry.inputId, component: entry.component },
    )
    const firstFork = taken.find(isForkAttach)
    const fork = firstFork === undefined ? [] : state.filter((component) => component.name === "fork")
    const rest = state.filter((component) => !fork.includes(component))
    const firstUser = delivered.findIndex((entry) => entry.kind === "user")
    delivered.splice(
      firstUser === -1 ? delivered.length : firstUser,
      0,
      ...rest.map((component) => ({ kind: "component" as const, inputId: crypto.randomUUID(), component })),
    )
    if (fork.length > 0) {
      const at = delivered.findIndex((entry) => entry.inputId === firstFork!.inputId)
      delivered.splice(at < 0 ? delivered.length : at, 0, {
        kind: "component",
        inputId: crypto.randomUUID(),
        component: fork[0]!,
      })
    }
    const membership: Array<TurnInput> = [
      { kind: "system", inputId: `system:${window.position}` },
      ...delivered.map((entry) => ({ kind: entry.kind === "component" ? ("developer" as const) : ("user" as const), inputId: entry.inputId })),
    ]
    return { delivered, membership, errors }
  }

  /**
   * Records an assembled batch in the turn's current checkpoint window.
   * Adjoining components form one developer message with its event; each
   * user message gets its `INPUT_RECEIVED`. The taken entries stop waiting.
   */
  private deliverInto(
    sessionId: string,
    turn: TurnRecord,
    delivered: ReturnType<SessionHub["assembleDelivery"]>["delivered"],
    errors: ReturnType<SessionHub["assembleDelivery"]>["errors"],
    taken: ReadonlyArray<WaitingEntry>,
    append: Append,
  ) {
    const window = this.conversation.currentWindow(sessionId)!
    for (const error of errors) append({ type: "SESSION_ERROR", code: error.code, message: error.message, runId: turn.runId })
    const owner = { runId: turn.runId, model: turn.model, agentTitle: turn.agentTitle }
    let message: Array<Component> = []
    const closeMessage = () => {
      if (message.length > 0) append({ type: "DEVELOPER_MESSAGE", runId: turn.runId, components: message.map(wire) })
      message = []
    }
    for (const entry of delivered) {
      if (entry.kind === "component") {
        this.conversation.appendItem(sessionId, window.position, owner, entry)
        message.push(entry.component)
        continue
      }
      closeMessage()
      const item = this.conversation.appendItem(sessionId, window.position, owner, {
        kind: "user",
        inputId: entry.entry.inputId,
        text: entry.entry.text,
        sender: entry.entry.sender,
        ...(entry.entry.attachments === undefined ? {} : { attachments: entry.entry.attachments }),
      })
      this.context.userMessage(sessionId, item.position, turn.runId)
      append({
        type: "INPUT_RECEIVED",
        inputId: entry.entry.inputId,
        text: entry.entry.text,
        mode: entry.entry.mode,
        sender: entry.entry.sender,
      })
    }
    closeMessage()
    for (const entry of taken) this.conversation.removeWaiting(sessionId, entry.position)
  }

  /**
   * Starts a turn with the `taken` waiting entries as its input, delivered
   * in the transaction that records the turn and its start event.
   */
  private startTurn(
    sessionId: string,
    taken: ReadonlyArray<WaitingEntry>,
    snapshot: { readonly research: ReadonlyArray<StoredFile>; readonly refs: ReadonlyArray<FileRef> },
  ) {
    const cause = takeCause(taken)
    const admission = startSpan("ashe_agent.turn_admission", { "ashe_agent.turn.cause": cause })
    let started = false
    try {
      const result = otelContext.with(withSpan(admission), () => this.startTurnBody(sessionId, taken, snapshot))
      started = true
      return result
    } finally {
      endSpan(admission, {}, started ? undefined : "turn_failed")
    }
  }

  private startTurnBody(
    sessionId: string,
    taken: ReadonlyArray<WaitingEntry>,
    snapshot: { readonly research: ReadonlyArray<StoredFile>; readonly refs: ReadonlyArray<FileRef> },
  ) {
    const state = this.state(sessionId)
    const runId = crypto.randomUUID()
    const current = this.session(sessionId)
    const admission = this.admissionSelection(current, taken)
    const { delivered, membership, errors } = this.assembleDelivery(sessionId, taken, admission.effective)
    const contextInput = taken.find(isContextInput)
    const association = contextInput?.kind === "notification" ? this.context.association(contextInput.workflowId) : null
    const { session, turn } = this.commit(sessionId, (append) => {
      const revisions = new Map<string, string>()
      for (const step of admission.steps) {
        if (
          step.before.agentTitle === step.profile.agentTitle &&
          step.before.modelSettings.modelId === step.profile.modelSettings.modelId &&
          step.before.modelSettings.reasoningEffort === step.profile.modelSettings.reasoningEffort
        ) {
          continue
        }
        revisions.set(step.inputId, this.store.setSettings(sessionId, step.profile))
      }
      const admitted = this.session(sessionId)
      const userMessageIds = taken.flatMap((entry) => (entry.kind === "user" ? [entry.inputId] : []))
      const cause = takeCause(taken)
      const turn = this.store.insertTurn(
        sessionId,
        {
          runId,
          cause,
          membership,
          userMessageIds,
          settingsRevision: admitted.settingsRevision,
          firstSeq: admitted.nextSeq,
          contextWorkflowId: association?.workflowId ?? null,
          contextStartItem: association?.startItem ?? null,
        },
        this.now(),
      )
      this.fileState.putFiles(snapshot.research)
      this.fileState.recordSnapshot(sessionId, turn.runId, snapshot.refs)
      this.deliverInto(sessionId, turn, delivered, errors, taken, append)
      for (const [inputId, revision] of revisions) this.store.setInputSettingsRevision(sessionId, turn.runId, inputId, revision)
      append({
        type: "RUN_STARTED",
        threadId: sessionId,
        runId: turn.runId,
        selection: effectiveSelection(turn.agentTitle, turn.model, turn.reasoningEffort),
        settingsRevision: turn.settingsRevision,
        cause,
        userMessageIds,
        membership,
      })
      this.context.turnStarted(turn)
      return {
        session: { ...admission.effective, settingsRevision: admitted.settingsRevision, nextSeq: admitted.nextSeq },
        turn,
      }
    })
    const readiness = this.selectionFailure(turn)
    if (readiness !== undefined) {
      this.failBeforeRun(sessionId, turn.runId, readiness.message, readiness.code)
      return
    }
    try {
      this.context.afterItems(sessionId, turn)
    } catch (error) {
      const message = `the turn could not start its context work: ${error instanceof Error ? error.message : String(error)}`
      this.failBeforeRun(sessionId, turn.runId, message, "turn_start_failed")
      return
    }
    const model = this.options.models.find((candidate) => candidate.id === turn.model)
    const span = startSpan("ashe_agent.turn", {
      ...(turn.model === null ? {} : { "ashe_agent.model": turn.model }),
      "ashe_agent.turn.cause": turn.cause,
    })
    const live: Live = { fiber: null as unknown as Fiber.Fiber<TurnOutcome>, turn, cancelled: false, span, startedAt: performance.now() }
    const owner = { runId: turn.runId, model: turn.model, agentTitle: turn.agentTitle }
    const rules = () => this.rulesForTurn(session, turn.agentTitle)
    const context: TurnContext = {
      session,
      turn,
      emit: (body) => this.emit(sessionId, body),
      window: () => {
        const window = this.conversation.currentWindow(sessionId)!
        return { position: window.position, harness: window.harnessInstructions, items: this.conversation.items(sessionId, window.position) }
      },
      tools: () => {
        const tools = this.offeredTools(rules(), sessionId)
        return this.context.isContextTurn(turn.runId)
          ? tools.filter((tool) => CONTEXT_TURN_TOOLS.includes(tool.spec.name))
          : tools
      },
      beginModelCall: (call) => {
        this.commit(sessionId, () => this.conversation.beginModelCall(sessionId, turn.runId, call, this.now()))
      },
      storeContent: (sha256, text) => this.conversation.putContent(sha256, text),
      discardModelCall: (modelCallId, outcome) => {
        this.commit(sessionId, () => this.conversation.endModelCall(sessionId, modelCallId, outcome, this.now()))
      },
      commitAssistant: (message, events, modelCallId) => {
        return this.commit(sessionId, (append) => {
          const window = this.conversation.currentWindow(sessionId)!
          this.conversation.commitModelCall(sessionId, modelCallId, message, this.now())
          const assistant = this.conversation.appendAssistant(sessionId, window.position, owner, message, modelCallId)
          const occurrences = new Map<string, Array<string>>()
          for (const [index, call] of (message.tool_calls ?? []).entries()) {
            const ids = occurrences.get(call.id!) ?? []
            if (assistant.toolInvocationIds[index] !== undefined) ids.push(assistant.toolInvocationIds[index]!)
            occurrences.set(call.id!, ids)
          }
          for (const body of events) {
            if (body.type === "TOOL_CALL_START" || body.type === "TOOL_CALL_END") {
              const invocationId = occurrences.get(body.toolCallId)?.shift()
              append(invocationId === undefined ? body : { ...body, invocationId })
            } else {
              append(body)
            }
          }
          return assistant.toolInvocationIds
        })
      },
      toolStarted: (invocationId) => {
        this.commit(sessionId, () => this.conversation.markToolStarted(sessionId, invocationId, this.now()))
      },
      afterCommit: () => this.context.afterItems(sessionId, turn),
      commitResult: (result, event, modelCallId, invocationId) => {
        this.commit(sessionId, (append) => {
          const window = this.conversation.currentWindow(sessionId)!
          this.conversation.appendToolResult(sessionId, window.position, owner, result, modelCallId, invocationId)
          append(event)
        })
        this.context.afterItems(sessionId, turn)
      },
      deliver: () => {
        this.checkScratch(sessionId)
        this.checkMemory(sessionId)
        const waiting = this.conversation.waiting(sessionId)
        return this.context.isContextTurn(turn.runId)
          ? waiting.some((entry) => entry.kind === "notification" && entry.component.name === "memory_restored")
          : waiting.some(isIndependent) || waiting.some(isContinuation) || waiting.some(isContextInput)
      },
      isCancelled: () => live.cancelled,
      authorize: (toolCallId, check, signal) =>
        this.authorize(sessionId, turn.runId, turn.agentTitle, rules(), toolCallId, check, signal),
      trace: withSpan(span),
      offered: (tool) => !whollyDenied(rules(), withholdingName(tool)),
      toolPolicy: this.toolPolicy,
      checkpointWindowSize: model === undefined ? Number.POSITIVE_INFINITY : checkpointWindowSize(model, session.modelOverrides[model.id]),
      isContextTurn: () => this.context.isContextTurn(turn.runId),
      reserveReached: (signal) => this.context.start(this.session(sessionId), turn, "threshold", signal),
      limitReached: (signal) => this.context.limitReached(this.session(sessionId), turn, signal),
      idle: (signal) => this.context.idle(this.session(sessionId), turn, signal),
    }
    const fiber = Effect.runFork(this.options.runner(context))
    live.fiber = fiber
    state.live = live
    fiber.addObserver((exit) => this.endTurn(sessionId, live, exit))
  }

  /** Finalizes a turn that failed before its runner started, then drains eligible input it left waiting. */
  private failBeforeRun(sessionId: string, runId: string, message: string, code: string) {
    this.commit(sessionId, (append) => {
      this.store.endTurn(sessionId, runId, "failed", this.now())
      append({ type: "RUN_ERROR", runId, message, code })
    })
    try {
      this.context.turnEnded(sessionId, runId, "failed")
    } catch (error) {
      const settlement = `settling the context workflow failed: ${error instanceof Error ? error.message : String(error)}`
      try {
        this.commit(sessionId, (append) => append({ type: "SESSION_ERROR", code: "context_workflow_failed", message: settlement }))
      } catch {
        // The persisted workflow remains active; the next turn or restart settles it.
      }
    }
    const state = this.state(sessionId)
    if (!this.stopping && !state.controlled) this.startNext(sessionId)
  }

  private endTurn(sessionId: string, live: Live, exit: Exit.Exit<TurnOutcome>) {
    const state = this.state(sessionId)
    state.live = null
    const runId = live.turn.runId
    let finalizationFailure: unknown = null
    const rememberFailure = (error: unknown) => {
      finalizationFailure ??= error
    }
    const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error))
    const finalizationMessage = () => `the turn could not be finalized: ${failureText(finalizationFailure)}`
    const recordFailure = () => {
      try {
        this.commit(sessionId, (append) => {
          this.store.endTurn(sessionId, runId, "failed", this.now())
          append({ type: "RUN_ERROR", runId, message: finalizationMessage(), code: "state_integrity_failed" })
        })
        return
      } catch (error) {
        rememberFailure(error)
      }
      // A terminal event write can fail independently of the row transition.
      try {
        this.commit(sessionId, () => this.store.endTurn(sessionId, runId, "failed", this.now()))
      } catch (error) {
        rememberFailure(error)
      }
    }
    try {
      for (const [requestId, ask] of [...state.asks.entries()]) {
        if (ask.runId !== runId) continue
        try {
          if (ask.actionId !== null) this.actions.cancel(ask.actionId, "the turn ended")
        } catch (error) {
          rememberFailure(error)
        }
        state.asks.delete(requestId)
        if (!this.stopping) continue
        try {
          this.emit(sessionId, {
            type: "PERMISSION_WITHDRAWN",
            requestId,
            reason: "restart",
          })
        } catch (error) {
          rememberFailure(error)
        }
      }
      this.endTurnSpan(live, exit)
      if (this.stopping) return
      const baseStatus: "finished" | "cancelled" | "failed" =
        live.cancelled
          ? "cancelled"
          : Exit.isSuccess(exit) && exit.value.status !== "failed"
            ? exit.value.status
            : Exit.isFailure(exit) && live.cancelled
              ? "cancelled"
              : "failed"
      let status = finalizationFailure === null ? baseStatus : "failed"
      try {
        this.commit(sessionId, (append) => {
          // No answer can apply to an ended turn, so its open requests are withdrawn with it.
          for (const requestId of this.openRequests(sessionId, runId)) {
            append({ type: "PERMISSION_WITHDRAWN", requestId, reason: "canceled" })
          }
          if (status === "finished") {
            this.store.endTurn(sessionId, runId, "finished", this.now())
            append({ type: "RUN_FINISHED", threadId: sessionId, runId, outcome: { type: "success" } })
          } else if (status === "cancelled") {
            this.store.endTurn(sessionId, runId, "cancelled", this.now())
            append({ type: "RUN_FINISHED", threadId: sessionId, runId, outcome: { type: "cancelled" } })
          } else {
            const failure =
              finalizationFailure !== null
                ? { message: finalizationMessage(), code: "state_integrity_failed" }
                : Exit.isSuccess(exit) && exit.value.status === "failed"
                  ? exit.value
                  : { message: "the turn failed", code: "internal" }
            this.store.endTurn(sessionId, runId, "failed", this.now())
            append({ type: "RUN_ERROR", runId, message: failure.message, ...(failure.code === undefined ? {} : { code: failure.code }) })
          }
        })
      } catch (error) {
        rememberFailure(error)
        status = "failed"
        recordFailure()
      }
      try {
        this.context.turnEnded(sessionId, runId, status)
      } catch (error) {
        const message = `settling the context workflow failed: ${failureText(error)}`
        try {
          this.commit(sessionId, (append) => append({ type: "SESSION_ERROR", code: "context_workflow_failed", message }))
        } catch {
          // The persisted workflow remains active; the next turn or restart settles it.
        }
      }
      if (finalizationFailure === null && !state.controlled) this.startNext(sessionId)
    } finally {
      const settled = state.settled
      state.settled = null
      settled?.()
    }
  }

  /** Ends the turn's span and records its duration, with how it ended. */
  private endTurnSpan(live: Live, exit: Exit.Exit<TurnOutcome>) {
    const [status, errorClass]: readonly ["finished" | "failed" | "canceled" | "interrupted", ErrorClass | undefined] =
      Exit.isSuccess(exit)
        ? exit.value.status === "finished"
          ? ["finished", undefined]
          : exit.value.status === "cancelled"
            ? ["canceled", undefined]
            : ["failed", exit.value.code !== undefined && isErrorClass(exit.value.code) ? exit.value.code : "turn_failed"]
        : live.cancelled
          ? ["canceled", undefined]
          : this.stopping
            ? ["interrupted", "interrupted"]
            : ["failed", "internal"]
    endSpan(live.span, { "ashe_agent.turn.status": status }, errorClass)
    recordDuration("ashe_agent.turn.duration", (performance.now() - live.startedAt) / 1000, {
      ...(live.turn.model === null ? {} : { "ashe_agent.model": live.turn.model }),
      "ashe_agent.turn.status": status,
    })
  }


  /** The turn `runId` when it is a rewind and fork point: a turn whose starting input holds a user message. */
  private point(sessionId: string, runId: string, settled = false): TurnRecord {
    const turn = this.store.getTurn(sessionId, runId)
    if (turn === null) throw notFound(`turn ${runId}`)
    if (turn.userMessageIds.length === 0) throw invalid(`turn ${runId} starts with no user message, so it is no rewind or fork point`)
    if (settled && turn.status === "running") throw invalid(`turn ${runId} has not settled, so it is no fork point`)
    return turn
  }

  /**
   * Copies the session through the turn `runId`, a fork point, or entirely,
   * into a new session with its own new directory. The new session gets
   * the research files and, as its first memory generation, the memory
   * files the source's next turn after the fork point started with, or the
   * source's current files without one, and a copy of the source's
   * scratch. Its first delivery reconciles the new session identity with a
   * fork component, and scratch lost and memory restored components the
   * copied history does not know start a turn.
   */
  fork(sessionId: string, runId: string | undefined): SessionSummary {
    const source = this.session(sessionId)
    const turns = this.store.turns(sessionId)
    const point =
      runId === undefined
        ? [...turns].reverse().find((turn) => turn.userMessageIds.length > 0 && turn.status !== "running")
        : this.point(sessionId, runId, true)
    if (point === undefined) throw invalid("the session has no settled turn starting with a user message to fork")
    if (!this.restoreIfPending(sessionId)) throw conflict("the session's files are being restored after a rewind; try again")
    const size = this.files.scratchSize(sessionId)
    if (size > SCRATCH_FORK_MAX_BYTES) {
      throw invalid(`the session's scratch holds ${size} bytes, over the fork limit of ${SCRATCH_FORK_MAX_BYTES} bytes`)
    }
    const next = turns.find((turn) => turn.position > point.position)
    const files =
      next === undefined
        ? this.currentFiles(sessionId)
        : { research: [], refs: this.fileState.snapshot(sessionId, next.runId) }
    const research = next === undefined ? files.research : this.fileState.files(files.refs.filter((ref) => ref.area === "research"))
    const memory = this.fileState.files(files.refs.filter((ref) => ref.area === "memory"))
    const generations = this.fileState.generations(sessionId)
    const id = this.newSessionId()
    this.withSessionFiles(id, () => {
      this.files.writeResearch(id, research)
      const recorded = this.files.writeGeneration(id, 1, memory)
      this.files.pointMemory(id, 1)
      const { skipped } = this.files.copyScratch(sessionId, id)
      this.store.db.transaction(() => {
        const createdAt = this.now()
        this.store.fork(source, { id, createdAt }, point.runId)
        this.fileState.recordGeneration(id, 1, recorded, createdAt)
        this.fileState.setGenerations(id, { scratch: generations.scratch, memoryRestore: generations.memoryRestore, forkSkipped: skipped })
        this.queueReconciledNotifications(id, "fork")
      })()
    })
    return this.summary(id)
  }

  /**
   * Removes the turn `runId`, a rewind point, and every later turn with
   * every row they own, records the restore of the research and memory
   * files the turn started with, and stores the rewind component, the
   * reconciled notifications the kept history does not know, and the user
   * messages of the turn's starting input, or `text` instead, as waiting
   * input with new ids, all in one transaction; a continuation turn's
   * continuation component waits first again. The restore then completes,
   * and its rerun turn starts after it.
   */
  async rewind(
    sessionId: string,
    runId: string,
    text: string | undefined,
    sender: Sender,
    options: { readonly selection?: SelectionPatch } = {},
  ) {
    this.session(sessionId)
    const state = this.state(sessionId)
    if (state.controlled) throw conflict("another history operation is changing the session")
    const turn = this.point(sessionId, runId)
    const users = new Map(
      this.conversation
        .turnItems(sessionId, runId)
        .flatMap((item) =>
          item.kind === "user"
            ? [[item.inputId, { text: item.text, attachments: item.attachments ?? [] }] as const]
            : [],
        ),
    )
    const messages =
      text === undefined
        ? turn.userMessageIds.map((id) => users.get(id) ?? { text: "", attachments: [] })
        : [
            {
              text,
              attachments: turn.userMessageIds.flatMap((id) => users.get(id)?.attachments ?? []),
            },
          ]
    const reconstructed = messages.map((message, index) => ({
      inputId: crypto.randomUUID(),
      ...message,
      ...(index === 0 && options.selection !== undefined ? { selection: options.selection } : {}),
    }))
    // A rerun continuation turn starts with its continuation component again, so its checkpoint window still opens with it.
    const continuation = this.conversation
      .turnItems(sessionId, runId)
      .find((item) => item.kind === "component" && item.component.name === "continuation")
    if (!this.restoreIfPending(sessionId)) throw conflict("the session's files are being restored after a rewind; try again")
    const restore = this.fileState.snapshot(sessionId, runId)
    state.controlled = true
    let failed = false
    try {
      const live = state.live
      if (live !== null) {
        const settled = new Promise<void>((resolve) => (state.settled = resolve))
        live.cancelled = true
        await Effect.runPromise(Fiber.interrupt(live.fiber))
        await settled
      }
      this.commit(sessionId, (append) => {
        this.fileState.recordPendingRestore(sessionId, restore, this.now())
        for (const message of reconstructed) {
          if (message.attachments.length > 0) {
            this.attachments.claim(senderOwner(sender), sessionId, message.inputId, message.attachments, this.now())
          }
        }
        this.store.removeFrom(sessionId, turn)
        const cleared = this.conversation.clearWaiting(sessionId)
        append({ type: "SESSION_REWOUND", runId: turn.runId, firstRemovedSeq: turn.firstSeq, clearedInputIds: [...cleared] })
        if (continuation?.kind === "component") this.queue(sessionId, continuation.component, "continuation")
        this.queue(sessionId, rewindComponent())
        this.queueReconciledNotifications(sessionId)
        for (const message of reconstructed) {
          const selection = message.selection
          this.conversation.addWaiting(
            sessionId,
            {
              kind: "user",
              inputId: message.inputId,
              text: message.text,
              mode: "steer",
              sender,
              ...(selection === undefined ? {} : { selection }),
              ...(message.attachments.length === 0 ? {} : { attachments: message.attachments }),
            },
            this.now(),
          )
          append({ type: "INPUT_WAITING", inputId: message.inputId, text: message.text, mode: "steer", sender })
        }
      })
      this.context.historyChanged(sessionId)
    } catch (error) {
      failed = true
      throw error
    } finally {
      state.controlled = false
      if (failed) this.startNext(sessionId)
    }
    if (this.restoreIfPending(sessionId)) this.startNext(sessionId)
  }

  /** Stops taking input and interrupts every running turn; their turns stay running for `recover`. */
  async stop() {
    this.stopping = true
    this.context.stop()
    const fibers = [...this.states.values()].flatMap((state) => (state.live === null ? [] : [state.live.fiber]))
    await Effect.runPromise(Fiber.interruptAll(fibers))
  }
}

export class Sessions extends Context.Service<Sessions, SessionHub>()("ashe-agent/sessions/Sessions") {
  /** The hub over the `Store` database, started before it serves. */
  static readonly layer = (
    options: Omit<HubOptions, "files"> & {
      /** The directory holding each session's directory. */
      readonly sessionsDir: string
      /** The directory holding each session's memory generations. */
      readonly memoryDir: string
      /** The directory holding each session's scratch target. */
      readonly scratchRoot: string
    },
  ) =>
    Layer.effect(
      Sessions,
      Effect.gen(function* () {
        const { db } = yield* Store
        return yield* Effect.acquireRelease(
          Effect.sync(() => {
            const files = new SessionFiles(options.sessionsDir, options.memoryDir, options.scratchRoot)
            const hub = new SessionHub(new SessionStore(db, options.sessionsDir), { ...options, files })
            hub.start()
            return hub
          }),
          (hub) => Effect.promise(() => hub.stop()),
        )
      }),
    )
}
