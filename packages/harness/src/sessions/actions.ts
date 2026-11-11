import { ActionDeclaration, ErrorCode, builtinActions, type Sender, type SessionEventBody } from "@ashe-agent/protocol"
import { Schema } from "effect"
import { IntegrityFailure } from "../agent/failure.ts"
import { draft07, ToolTimedOut, type ToolClock } from "../agent/tools.ts"
import { ProtocolError, type Connection } from "../server/websocket.ts"
import { endSpan, recordDuration, startSpan } from "../telemetry/signals.ts"

export class ActionUnavailable extends Error {
  constructor(readonly action: string) {
    super(`the ${action} action is unavailable: no connected session subscriber supports it`)
  }
}

export class ActionDisconnected extends Error {
  constructor(readonly action: string) {
    super(`the assigned client disconnected before completing ${action}`)
  }
}

export class ActionCanceled extends Error {
  constructor(readonly action: string, readonly reason: string) {
    super(`the assigned client canceled ${action}: ${reason}`)
  }
}

export class ActionTimedOut extends Error {
  constructor(readonly action: string, readonly afterMs: number) {
    super(`the assigned client did not complete ${action} within ${afterMs} ms`)
  }
}

export class ActionInvalid extends Error {}

interface Definition {
  readonly name: string
  readonly description: string
  readonly args: Schema.Top
  readonly result: Schema.Top
  readonly declaration: ActionDeclaration
}

interface Participant {
  readonly id: string
  readonly principal: Sender
  send: (message: unknown) => void
  readonly actions: Set<string>
  /** The server's subscription order for each session, lower being older. */
  readonly sessions: Map<string, number>
  active: boolean
}

interface Pending {
  readonly id: string
  readonly sessionId: string
  readonly participantId: string
  readonly definition: Definition
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  readonly clock: ToolClock
  readonly timer: unknown
  readonly signal: AbortSignal | undefined
  readonly onAbort: (() => void) | null
  readonly span: ReturnType<typeof startSpan>
  readonly startedAt: number
  readonly runId: string | null
  attention: boolean
}

type Settlement = "completed" | "canceled" | "timedOut" | "disconnected" | "failed"
type SettlementError = "canceled" | "interrupted" | "invalid_params" | "internal"

const settleSpan = (pending: Pending, outcome: Settlement, error?: SettlementError) => {
  endSpan(pending.span, { "ashe_agent.action.outcome": outcome }, error)
  recordDuration("ashe_agent.action.duration", (performance.now() - pending.startedAt) / 1000, {
    "ashe_agent.action.name": pending.definition.name,
    "ashe_agent.action.outcome": outcome,
  })
}

const observationFailure = (error: unknown) =>
  error instanceof IntegrityFailure
    ? error
    : new IntegrityFailure(`the action settlement could not be recorded: ${error instanceof Error ? error.message : String(error)}`)

export interface ActionRunOptions {
  readonly sessionId: string
  /** The AgentTurn whose execution owns this assignment. */
  readonly runId?: string
  readonly clock: ToolClock
  readonly signal?: AbortSignal
  /** The caller's absolute deadline in milliseconds on `clock`. */
  readonly deadline?: number
  readonly onAssigned?: (actionId: string) => void
}

export interface ActionOutcome<A> {
  readonly actionId: string
  readonly result: A
  readonly principal: Sender
}

const definitions = new Map<string, Definition>(
  Object.entries(builtinActions).map(([name, action]) => [
    name,
    {
      name,
      description: action.description,
      args: action.args,
      result: action.result,
      declaration: { name, description: action.description, input: draft07(action.args), output: draft07(action.result) },
    },
  ]),
)

/**
 * The exclusive client action broker: authenticated connections advertise
 * declared actions, subscribe to sessions, receive directed live commands,
 * and complete only their own live assignment.
 */
export class ActionBroker {
  private readonly participants = new Map<string, Participant>()
  private readonly pending = new Map<string, Pending>()
  private subscriptionOrder = 0

  constructor(private readonly observe: (sessionId: string, body: SessionEventBody) => void = () => {}) {}

  declarations(): ReadonlyArray<ActionDeclaration> {
    return [...definitions.values()].map((definition) => definition.declaration)
  }

  /** Live validated human-interaction hints for one session's owner observation. */
  attentionForSession(sessionId: string) {
    return [...this.pending.values()]
      .filter((pending) => pending.sessionId === sessionId && pending.attention)
      .map((pending) => ({
        actionId: pending.id,
        name: pending.definition.name,
        runId: pending.runId,
        needsHumanInput: true as const,
      }))
  }

  /** Registers or refreshes the connection's directed-message sender. */
  register(connection: Connection, principal: Sender, send: (message: unknown) => void) {
    const existing = this.participants.get(connection.id)
    if (existing !== undefined) {
      existing.send = send
      return
    }
    this.participants.set(connection.id, { id: connection.id, principal, send, actions: new Set(), sessions: new Map(), active: true })
  }

  /** Replaces the connection's advertised action support. */
  setCapabilities(connection: Connection, principal: Sender, actions: ReadonlyArray<string>, send: (message: unknown) => void) {
    const unknown = actions.find((name) => !definitions.has(name))
    if (unknown !== undefined) throw new ProtocolError({ code: ErrorCode.invalidInput, message: `no declared action ${unknown}` })
    this.register(connection, principal, send)
    const participant = this.participants.get(connection.id)!
    participant.actions.clear()
    for (const name of actions) participant.actions.add(name)
  }

  /** Records a server-owned subscription order; re-subscribing makes the connection newest again. */
  subscribed(connection: Connection, principal: Sender, sessionId: string, send: (message: unknown) => void) {
    this.register(connection, principal, send)
    this.participants.get(connection.id)!.sessions.set(sessionId, ++this.subscriptionOrder)
  }

  unsubscribed(connection: Connection, sessionId: string) {
    this.participants.get(connection.id)?.sessions.delete(sessionId)
  }

  /** A dropped connection loses all capability and subscription state and fails its assignments. */
  disconnect(connectionId: string) {
    const participant = this.participants.get(connectionId)
    if (participant !== undefined) participant.active = false
    this.participants.delete(connectionId)
    for (const action of [...this.pending.values()]) {
      if (action.participantId !== connectionId) continue
      this.pending.delete(action.id)
      this.clearAttention(action)
      this.detach(action)
      const failure = this.recordSettlement(action, "disconnected", "interrupted")
      action.reject(failure ?? new ActionDisconnected(action.definition.name))
    }
  }

  private eligible(sessionId: string, name: string): Participant | null {
    let selected: Participant | null = null
    let order = -1
    for (const participant of this.participants.values()) {
      if (!participant.active || !participant.actions.has(name)) continue
      const subscribed = participant.sessions.get(sessionId)
      if (subscribed === undefined || subscribed <= order) continue
      selected = participant
      order = subscribed
    }
    return selected
  }

  /** Whether a capable connected subscriber currently exists for a new assignment. */
  available(sessionId: string, name: string): boolean {
    return this.eligible(sessionId, name) !== null
  }

  /** Runs one action, assigning it once to the most recently subscribed capable connection. */
  run<A>(name: string, args: unknown, options: ActionRunOptions): Promise<ActionOutcome<A>> {
    const definition = definitions.get(name)
    if (definition === undefined) throw new Error(`no declared action ${name}`)
    const participant = this.eligible(options.sessionId, name)
    if (participant === null) throw new ActionUnavailable(name)
    const decoded = Schema.decodeUnknownExit(definition.args as Schema.Codec<unknown, unknown>)(args, { onExcessProperty: "error" })
    if (decoded._tag === "Failure") throw new ActionInvalid(String(decoded.cause))
    const id = crypto.randomUUID()
    const remaining =
      options.deadline === undefined || !Number.isFinite(options.deadline)
        ? null
        : Math.max(0, options.deadline - options.clock.now())
    if (remaining !== null && remaining <= 0) throw new ActionTimedOut(name, 0)
    return new Promise<ActionOutcome<A>>((resolve, reject) => {
      const span = startSpan("ashe_agent.action", { "ashe_agent.action.name": name })
      const startedAt = performance.now()
      let onAbort: (() => void) | null = null
      const finish = (error?: Error) => {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        this.clearAttention(pending)
        this.detach(pending)
        const failure = this.recordSettlement(pending, "failed", "internal")
        pending.reject(failure ?? error ?? new Error(`action ${name} ended without a result`))
      }
      const cancel = (reason: string, error: Error, outcome: "canceled" | "timedOut" = "canceled") => {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        this.clearAttention(pending)
        this.detach(pending)
        const current = this.participants.get(participant.id)
        if (current?.active === true) {
          try {
            current.send({ jsonrpc: "2.0", method: "action.cancel", params: { actionId: id, sessionId: options.sessionId, reason } })
          } catch {
            // The observed settlement still closes the action and its caller.
          }
        }
        const failure = this.recordSettlement(pending, outcome, "canceled")
        pending.reject(failure ?? error)
      }
      const signal = options.signal
      if (signal?.aborted === true) {
        endSpan(span, { "ashe_agent.action.outcome": "canceled" }, "canceled")
        recordDuration("ashe_agent.action.duration", (performance.now() - startedAt) / 1000, {
          "ashe_agent.action.name": name,
          "ashe_agent.action.outcome": "canceled",
        })
        reject(signal.reason)
        return
      }
      if (signal !== undefined) {
        onAbort = () =>
          cancel(
            "canceled",
            signal.reason instanceof Error ? signal.reason : new ActionCanceled(name, "canceled"),
            signal.reason instanceof ToolTimedOut ? "timedOut" : "canceled",
          )
        signal.addEventListener("abort", onAbort, { once: true })
      }
      const timer =
        remaining === null
          ? null
          : options.clock.setTimeout(() => cancel("timed out", new ActionTimedOut(name, remaining), "timedOut"), remaining)
      this.pending.set(id, {
        id,
        sessionId: options.sessionId,
        participantId: participant.id,
        definition,
        resolve: (result) => resolve({ actionId: id, result: result as A, principal: participant.principal }),
        reject,
        clock: options.clock,
        timer,
        signal,
        onAbort,
        span,
        startedAt,
        runId: options.runId ?? null,
        attention: false,
      })
      try {
        options.onAssigned?.(id)
        this.observe(options.sessionId, { type: "ACTION_ASSIGNED", actionId: id, name })
        participant.send({
          jsonrpc: "2.0",
          method: "action.execute",
          params: { actionId: id, sessionId: options.sessionId, name, arguments: args },
        })
      } catch (error) {
        finish(error instanceof Error ? error : new ActionDisconnected(name))
      }
    })
  }

  /** Completes an assignment from its one authorized connection, validating its declared result. */
  complete(connectionId: string, sessionId: string, actionId: string, result: unknown) {
    const pending = this.pending.get(actionId)
    if (pending === undefined) throw new ProtocolError({ code: ErrorCode.alreadyResolved, message: `action ${actionId} is already settled` })
    if (pending.participantId !== connectionId || pending.sessionId !== sessionId) {
      throw new ProtocolError({ code: ErrorCode.conflict, message: `action ${actionId} is assigned to another connection or session` })
    }
    const decoded = Schema.decodeUnknownExit(pending.definition.result as Schema.Codec<unknown, unknown>)(result, {
      onExcessProperty: "error",
    })
    if (decoded._tag === "Failure") {
      this.pending.delete(actionId)
      this.clearAttention(pending)
      this.detach(pending)
      const message = `action ${actionId} returned an invalid result: ${String(decoded.cause)}`
      const failure = this.recordSettlement(pending, "failed", "invalid_params")
      if (failure !== null) {
        pending.reject(failure)
        throw failure
      }
      pending.reject(new ActionInvalid(message))
      throw new ProtocolError({ code: ErrorCode.invalidParams, message })
    }
    this.pending.delete(actionId)
    this.clearAttention(pending)
    this.detach(pending)
    const failure = this.recordSettlement(pending, "completed")
    if (failure !== null) {
      pending.reject(failure)
      throw failure
    }
    pending.resolve(decoded.value)
  }

  /** Cancels a live assignment, sending its executor a directed cancellation when connected. */
  cancel(actionId: string, reason: string, outcome: "canceled" | "timedOut" = "canceled") {
    const pending = this.pending.get(actionId)
    if (pending === undefined) return false
    this.pending.delete(actionId)
    this.clearAttention(pending)
    this.detach(pending)
    const participant = this.participants.get(pending.participantId)
    if (participant?.active === true) {
      try {
        participant.send({ jsonrpc: "2.0", method: "action.cancel", params: { actionId, sessionId: pending.sessionId, reason } })
      } catch {
        // Cancellation settles even when the executor's socket already failed.
      }
    }
    const failure = this.recordSettlement(pending, outcome, "canceled")
    pending.reject(failure ?? new ActionCanceled(pending.definition.name, reason))
    return true
  }

  private recordSettlement(pending: Pending, outcome: Settlement, errorClass?: SettlementError): IntegrityFailure | null {
    try {
      this.observe(pending.sessionId, {
        type: "ACTION_SETTLED",
        actionId: pending.id,
        name: pending.definition.name,
        outcome,
      })
      settleSpan(pending, outcome, errorClass)
      return null
    } catch (error) {
      settleSpan(pending, "failed", "internal")
      return observationFailure(error)
    }
  }

  /** Reports the assigned connection's human-interaction need for its live action. */
  reportInteraction(connectionId: string, actionId: string, needsHumanInput: boolean) {
    const pending = this.pending.get(actionId)
    if (pending === undefined) {
      throw new ProtocolError({ code: ErrorCode.alreadyResolved, message: `action ${actionId} is already settled` })
    }
    if (pending.participantId !== connectionId) {
      throw new ProtocolError({ code: ErrorCode.conflict, message: `action ${actionId} is assigned to another connection` })
    }
    if (pending.attention === needsHumanInput) return
    pending.attention = needsHumanInput
    this.observe(pending.sessionId, {
      type: "ACTION_ATTENTION",
      actionId: pending.id,
      name: pending.definition.name,
      runId: pending.runId,
      needsHumanInput,
    })
  }

  /** Withdraws a live attention hint before its action settles or disconnects. */
  private clearAttention(pending: Pending) {
    if (!pending.attention) return
    pending.attention = false
    this.observe(pending.sessionId, {
      type: "ACTION_ATTENTION",
      actionId: pending.id,
      name: pending.definition.name,
      runId: pending.runId,
      needsHumanInput: false,
    })
  }

  private detach(pending: Pending) {
    if (pending.timer !== null) pending.clock.clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.onAbort !== null) pending.signal.removeEventListener("abort", pending.onAbort)
  }
}
