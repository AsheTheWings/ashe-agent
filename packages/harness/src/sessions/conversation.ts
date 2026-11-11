import type { Database } from "bun:sqlite"
import { AIMessage, mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages, type StoredMessage } from "@langchain/core/messages"
import type { InputMode, SelectionPatch, Sender } from "@ashe-agent/protocol"
import type { RetainedAttachmentRef, RetainedContent } from "@ashe-agent/protocol"
import { UNTITLED_AGENT_TITLE } from "@ashe-agent/protocol"
import type { ToolContent, ToolOutcome } from "../agent/window.ts"
import type { Component, SourceName, SourceStates } from "../context/components.ts"

export type ItemBody =
  | { readonly kind: "component"; readonly component: Component }
  | {
      readonly kind: "user"
      readonly inputId: string
      readonly text: string
      readonly sender: Sender
      readonly attachments?: ReadonlyArray<RetainedAttachmentRef>
    }
  | { readonly kind: "assistant"; readonly message: AIMessage }
  | {
      readonly kind: "result"
      readonly callId: string
      readonly name: string
      readonly content: ToolContent
      readonly outcome: ToolOutcome
      readonly cleared?: boolean
    }

export type Item = ItemBody & {
  readonly entryId: string
  readonly position: number
  readonly runId: string | null
  readonly model: string | null
  readonly agentTitle: string
  readonly contentId: string
  readonly modelCallId: string | null
  readonly authorshipSessionId: string
  readonly ownershipKind: "local" | "inherited"
  readonly sourceSessionId: string | null
  readonly contentFormat: string
  readonly representationId: string
}

export interface CheckpointWindow {
  readonly position: number
  readonly runId: string | null
  readonly harnessInstructions: string
  readonly harnessContentId: string | null
}

export type WaitingEntry =
  | {
      readonly position: number
      readonly kind: "user"
      readonly inputId: string
      readonly text: string
      readonly mode: InputMode
      readonly sender: Sender
      readonly attachments?: ReadonlyArray<RetainedAttachmentRef>
      readonly selection?: SelectionPatch
    }
  | {
      readonly position: number
      readonly kind: "notification"
      readonly inputId: string
      readonly component: Component
      readonly trigger: "notification" | "continuation" | "fork" | "context"
      readonly workflowId?: string
    }

export type NewWaitingEntry =
  | Omit<Extract<WaitingEntry, { kind: "user" }>, "position">
  | Omit<Extract<WaitingEntry, { kind: "notification" }>, "position">

interface EntryRow {
  entry_id: string
  position: number
  owner_turn_id: string | null
  kind: string
  content_sha256: string
  content: Uint8Array
  format: string
  agent_title: string
  model_id: string | null
  model_call_id: string | null
  cleared: number
  cleared_ref: string | null
  authorship_session_id: string
  ownership_kind: "local" | "inherited"
  source_session_id: string | null
  provider_call_id: string | null
  tool_name: string | null
  result_ref: string | null
  outcome: ToolOutcome | null
}

const entryColumns = `e.entry_id, e.position, e.owner_turn_id, e.kind, e.content_sha256,
  c.data AS content, c.format, e.agent_title, e.model_id, e.model_call_id,
  e.authorship_session_id, e.ownership_kind, e.source_session_id,
  (SELECT count(*) FROM context_result_replacements r WHERE r.session_id = e.session_id AND r.entry_id = e.entry_id) AS cleared,
  (SELECT r.replacement_ref FROM context_result_replacements r WHERE r.session_id = e.session_id AND r.entry_id = e.entry_id ORDER BY r.attempt DESC LIMIT 1) AS cleared_ref,
  a.provider_call_id, a.name AS tool_name, a.result_ref, a.outcome`
const entryTables = `session_entries e JOIN contents c ON c.sha256 = e.content_sha256
  LEFT JOIN agent_tools a ON a.session_id = e.session_id AND a.entry_id = e.entry_id`

const JSON_FORMAT = "application/json"
const ASSISTANT_FORMAT = "application/vnd.ashe-agent.assistant+json"
const LEGACY_ASSISTANT_FORMAT = "application/vnd.langchain.stored-message+json"

interface AssistantContent {
  readonly messageId: string | null
  readonly text: string
  readonly content?: string | Array<Record<string, unknown>>
  readonly additional_kwargs?: Record<string, unknown>
  readonly response_metadata?: Record<string, unknown>
}

const textContent = (message: AIMessage): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.flatMap((part) => (typeof part === "object" && part.type === "text" ? [part.text] : [])).join("")

const reasoningText = (message: AIMessage): string =>
  typeof message.content === "string"
    ? ""
    : message.content
        .flatMap((part) =>
          typeof part === "object" && part.type === "reasoning" && typeof part.reasoning === "string" ? [part.reasoning] : [],
        )
        .join("")

const decodeContent = (row: EntryRow): unknown => JSON.parse(Buffer.from(row.content).toString("utf8"))

const itemFromRow = (row: EntryRow, cleared: boolean): Item | null => {
  const base = {
    entryId: row.entry_id,
    position: row.position,
    runId: row.owner_turn_id,
    model: row.model_id,
    agentTitle: row.agent_title,
    contentId: row.content_sha256,
    modelCallId: row.model_call_id,
    authorshipSessionId: row.authorship_session_id,
    ownershipKind: row.ownership_kind,
    sourceSessionId: row.source_session_id,
    contentFormat: row.format,
    representationId: row.cleared_ref ?? row.content_sha256,
  }
  if (row.kind === "developer") return { ...base, ...(decodeContent(row) as Extract<ItemBody, { kind: "component" }>) }
  if (row.kind === "user") return { ...base, ...(decodeContent(row) as Extract<ItemBody, { kind: "user" }>) }
  if (row.kind === "agent") {
    if (row.format === LEGACY_ASSISTANT_FORMAT) {
      const stored = decodeContent(row) as StoredMessage
      return { ...base, kind: "assistant", message: mapStoredMessagesToChatMessages([stored])[0] as AIMessage }
    }
    const content = decodeContent(row) as AssistantContent
    return {
      ...base,
      kind: "assistant",
      message: new AIMessage({
        content: (content.content ?? content.text) as string,
        ...(content.messageId === null ? {} : { id: content.messageId }),
        ...(content.additional_kwargs === undefined ? {} : { additional_kwargs: content.additional_kwargs }),
        ...(content.response_metadata === undefined ? {} : { response_metadata: content.response_metadata }),
      }),
    }
  }
  if (row.kind === "tool" && row.result_ref !== null) {
    const result = JSON.parse(Buffer.from(row.content).toString("utf8")) as {
      readonly content?: ToolContent
      readonly callId?: string
      readonly name?: string
      readonly outcome?: ToolOutcome
    }
    const legacy = row.format !== JSON_FORMAT
    return {
      ...base,
      kind: "result",
      callId: legacy ? (result.callId ?? row.provider_call_id ?? row.entry_id) : (row.provider_call_id ?? row.entry_id),
      name: legacy ? (result.name ?? row.tool_name ?? "unknown") : (row.tool_name ?? "unknown"),
      content: result.content ?? "",
      outcome: legacy ? (result.outcome ?? row.outcome ?? "failed") : (row.outcome ?? "failed"),
      cleared,
    }
  }
  return null
}

export class Conversation {
  constructor(readonly db: Database) {}

  private sessionProfile(sessionId: string): { readonly agentTitle: string; readonly modelId: string | null } {
    const row = this.db
      .query<{ agent_title: string; model_id: string | null }, [string]>(
        `SELECT s.agent_title, s.model_id FROM sessions x
          JOIN session_settings s ON s.session_id = x.id AND s.revision = x.current_settings_revision
          WHERE x.id = ?`,
      )
      .get(sessionId)
    return row === null ? { agentTitle: UNTITLED_AGENT_TITLE, modelId: null } : { agentTitle: row.agent_title, modelId: row.model_id }
  }

  private putJson(value: unknown, format = JSON_FORMAT): string {
    const text = JSON.stringify(value)
    const sha = new Bun.CryptoHasher("sha256").update(text).digest("hex")
    this.db
      .query("INSERT INTO contents (sha256, data, format) VALUES (?, ?, ?) ON CONFLICT (sha256) DO NOTHING")
      .run(sha, Buffer.from(text, "utf8"), format)
    return sha
  }

  putJsonContent(value: unknown): string {
    return this.putJson(value)
  }

  private nextPosition(sessionId: string): number {
    return (
      (this.db.query<{ p: number | null }, [string]>("SELECT max(position) AS p FROM session_entries WHERE session_id = ?").get(sessionId)?.p ?? 0) + 1
    )
  }

  private appendEntry(
    sessionId: string,
    window: number,
    owner: { readonly runId: string; readonly model: string | null; readonly agentTitle?: string } | null,
    kind: "developer" | "user" | "agent" | "thought" | "tool",
    content: unknown,
    options: { readonly format?: string; readonly modelCallId?: string | null } = {},
  ): { readonly entryId: string; readonly position: number; readonly contentId: string } {
    const profile = this.sessionProfile(sessionId)
    const entryId = crypto.randomUUID()
    const position = this.nextPosition(sessionId)
    const contentId = this.putJson(content, options.format)
    this.db
      .query(
        `INSERT INTO session_entries
          (session_id, entry_id, position, owner_turn_id, kind, content_sha256, model_call_id,
           agent_title, model_id, authorship_session_id, ownership_kind, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?)`,
      )
      .run(
        sessionId,
        entryId,
        position,
        owner?.runId ?? null,
        kind,
        contentId,
        options.modelCallId ?? null,
        owner?.agentTitle ?? profile.agentTitle,
        owner?.model ?? profile.modelId,
        sessionId,
        Date.now(),
      )
    this.db
      .query("INSERT INTO window_entries (session_id, window_position, entry_id) VALUES (?, ?, ?)")
      .run(sessionId, window, entryId)
    return { entryId, position, contentId }
  }

  private rows(query: string, params: ReadonlyArray<string | number>): ReadonlyArray<Item> {
    return this.db
      .query<EntryRow, (string | number)[]>(query)
      .all(...params)
      .flatMap((row) => {
        if (row.kind === "thought") return []
        const item = itemFromRow(row, row.cleared === 1)
        return item === null ? [] : [item]
      })
      .map((item) => {
        if (item.kind !== "assistant" || item.modelCallId === null || item.message.tool_calls?.length) return item
        const calls = this.db
          .query<{ provider_call_id: string | null; name: string; arguments: Uint8Array }, [string, string]>(
            `SELECT a.provider_call_id, a.name, c.data AS arguments FROM agent_tools a
              JOIN session_entries e ON e.session_id = a.session_id AND e.entry_id = a.entry_id
              JOIN contents c ON c.sha256 = a.arguments_ref
              WHERE a.session_id = ? AND a.model_call_id = ? ORDER BY e.position`,
          )
          .all(String(params[0]), item.modelCallId)
          .flatMap((call) =>
            call.provider_call_id === null
              ? []
              : [
                  {
                    id: call.provider_call_id,
                    name: call.name,
                    args: JSON.parse(Buffer.from(call.arguments).toString("utf8")).arguments as Record<string, unknown>,
                  },
                ],
          )
        if (calls.length === 0) return item
        return {
          ...item,
          message: new AIMessage({
            content: item.message.content,
            ...(item.message.id === undefined ? {} : { id: item.message.id }),
            additional_kwargs: item.message.additional_kwargs,
            response_metadata: item.message.response_metadata,
            tool_calls: calls,
          }),
        }
      })
  }

  currentWindow(sessionId: string): CheckpointWindow | null {
    const row = this.db
      .query<{ position: number; run_id: string | null; harness_instructions: string; harness_content_sha256: string | null }, [string]>(
        `SELECT position, run_id, harness_instructions, harness_content_sha256 FROM checkpoint_windows
          WHERE session_id = ? ORDER BY position DESC LIMIT 1`,
      )
      .get(sessionId)
    if (row === null) return null
    const harness = row.harness_content_sha256 === null ? null : this.content(row.harness_content_sha256)
    return {
      position: row.position,
      runId: row.run_id,
      harnessInstructions: harness ?? row.harness_instructions,
      harnessContentId: row.harness_content_sha256,
    }
  }

  insertWindow(sessionId: string, runId: string | null, harnessInstructions: string, createdAt: number): CheckpointWindow {
    const position =
      (this.db.query<{ p: number | null }, [string]>("SELECT max(position) AS p FROM checkpoint_windows WHERE session_id = ?").get(sessionId)?.p ?? 0) + 1
    const contentId = new Bun.CryptoHasher("sha256").update(harnessInstructions).digest("hex")
    this.putContent(contentId, harnessInstructions)
    this.db
      .query(
        `INSERT INTO checkpoint_windows
          (session_id, position, run_id, harness_instructions, harness_content_sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, position, runId, harnessInstructions, contentId, createdAt)
    return { position, runId, harnessInstructions, harnessContentId: contentId }
  }

  items(sessionId: string, window: number): ReadonlyArray<Item> {
    return this.rows(
      `SELECT ${entryColumns} FROM ${entryTables}
        JOIN window_entries w ON w.session_id = e.session_id AND w.entry_id = e.entry_id
        WHERE e.session_id = ? AND w.window_position = ? ORDER BY e.position`,
      [sessionId, window],
    )
  }

  turnItems(sessionId: string, runId: string): ReadonlyArray<Item> {
    return this.rows(`SELECT ${entryColumns} FROM ${entryTables} WHERE e.session_id = ? AND e.owner_turn_id = ? ORDER BY e.position`, [
      sessionId,
      runId,
    ])
  }

  itemsFrom(sessionId: string, from: number): ReadonlyArray<Item> {
    return this.rows(`SELECT ${entryColumns} FROM ${entryTables} WHERE e.session_id = ? AND e.position >= ? ORDER BY e.position`, [
      sessionId,
      from,
    ])
  }

  lastItemPosition(sessionId: string): number {
    return this.db.query<{ p: number | null }, [string]>("SELECT max(position) AS p FROM session_entries WHERE session_id = ?").get(sessionId)?.p ?? 0
  }

  beginModelCall(
    sessionId: string,
    runId: string,
    call: {
      readonly modelCallId: string
      readonly inputBoundaryId: string
      readonly ordinal: number
      readonly windowPosition: number
      readonly request: unknown
      readonly offeredTools: unknown
    },
    startedAt: number,
  ) {
    if (typeof call.request === "object" && call.request !== null && "instructions" in call.request && typeof call.request.instructions === "string") {
      const digest = new Bun.CryptoHasher("sha256").update(call.request.instructions).digest("hex")
      this.putContent(digest, call.request.instructions)
    }
    const manifestRef = this.putJson(call.request)
    const toolsRef = this.putJson(call.offeredTools)
    this.db
      .query(
        `INSERT INTO model_calls
          (session_id, model_call_id, turn_id, ordinal, window_position, input_manifest_ref,
           offered_tools_ref, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, call.modelCallId, runId, call.ordinal, call.windowPosition, manifestRef, toolsRef, startedAt)
    this.db
      .query(
        `INSERT INTO request_manifests (session_id, manifest_id, model_call_id, body_ref, created_at)
          VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, call.inputBoundaryId, call.modelCallId, manifestRef, startedAt)
    const rendered = new Set<string>()
    const request = call.request as {
      readonly providerInput?: { readonly contentId?: string }
      readonly contributions?: ReadonlyArray<{ readonly rendered?: { readonly contentId?: string } }>
    }
    if (request.providerInput?.contentId !== undefined) rendered.add(request.providerInput.contentId)
    for (const contribution of request.contributions ?? []) {
      if (contribution.rendered?.contentId !== undefined) rendered.add(contribution.rendered.contentId)
    }
    const retain = this.db.query(
      "INSERT OR IGNORE INTO request_manifest_rendered (session_id, manifest_id, content_ref) VALUES (?, ?, ?)",
    )
    for (const contentRef of rendered) retain.run(sessionId, call.inputBoundaryId, contentRef)
  }

  nextModelCallOrdinal(sessionId: string, windowPosition: number): number {
    return (
      this.db
        .query<{ ordinal: number | null }, [string, number]>(
          "SELECT max(ordinal) AS ordinal FROM model_calls WHERE session_id = ? AND window_position = ?",
        )
        .get(sessionId, windowPosition)?.ordinal ?? -1
    ) + 1
  }

  commitModelCall(sessionId: string, modelCallId: string, message: AIMessage, endedAt: number) {
    const replay = JSON.stringify(mapChatMessagesToStoredMessages([message])[0])
    const replayRef = new Bun.CryptoHasher("sha256").update(replay).digest("hex")
    this.putContent(replayRef, replay, LEGACY_ASSISTANT_FORMAT)
    this.db
      .query(
        `UPDATE model_calls SET ended_at = ?, outcome = 'success', provider_replay_ref = ?
          WHERE session_id = ? AND model_call_id = ?`,
      )
      .run(endedAt, replayRef, sessionId, modelCallId)
  }

  endModelCall(sessionId: string, modelCallId: string, outcome: "failed" | "cancelled" | "interrupted", endedAt: number) {
    this.db
      .query("UPDATE model_calls SET ended_at = ?, outcome = ? WHERE session_id = ? AND model_call_id = ?")
      .run(endedAt, outcome, sessionId, modelCallId)
  }

  successfulManifests(sessionId: string): ReadonlyArray<{ readonly modelCallId: string; readonly manifest: unknown }> {
    return this.db
      .query<{ model_call_id: string; body: Uint8Array }, [string]>(
        `SELECT m.model_call_id, c.data AS body FROM model_calls m
          JOIN request_manifests r ON r.session_id = m.session_id AND r.model_call_id = m.model_call_id
          JOIN contents c ON c.sha256 = r.body_ref
          WHERE m.session_id = ? AND m.outcome = 'success'
          ORDER BY m.started_at, m.rowid`,
      )
      .all(sessionId)
      .map((row) => ({ modelCallId: row.model_call_id, manifest: JSON.parse(Buffer.from(row.body).toString("utf8")) }))
  }

  latestSuccessfulManifest(sessionId: string): { readonly modelCallId: string; readonly manifest: unknown } | null {
    return this.successfulManifests(sessionId).at(-1) ?? null
  }

  clear(sessionId: string, runId: string, attempt: number, positions: ReadonlyArray<number>) {
    const replacement = this.putContent(
      "cleared-result",
      "[Result cleared to free context. Run the call again if you need it.]",
    )
    const insert = this.db.query(
      `INSERT OR REPLACE INTO context_result_replacements (session_id, entry_id, run_id, attempt, replacement_ref)
        SELECT ?, entry_id, ?, ?, ? FROM session_entries WHERE session_id = ? AND position = ?`,
    )
    for (const position of positions) insert.run(sessionId, runId, attempt, replacement, sessionId, position)
  }

  baseline(sessionId: string, window: number): ReadonlyArray<{ readonly name: string; readonly sha256: string }> {
    const row = this.db
      .query<{ files: string }, [string, number]>(
        "SELECT files FROM research_baselines WHERE session_id = ? AND window_position = ? ORDER BY position DESC LIMIT 1",
      )
      .get(sessionId, window)
    return row === null ? [] : JSON.parse(row.files)
  }

  recordBaseline(sessionId: string, window: number, runId: string | null, files: ReadonlyArray<{ readonly name: string; readonly sha256: string }>) {
    const position =
      (this.db.query<{ p: number | null }, [string]>("SELECT max(position) AS p FROM research_baselines WHERE session_id = ?").get(sessionId)?.p ?? 0) + 1
    this.db
      .query("INSERT INTO research_baselines (session_id, position, window_position, run_id, files) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, position, window, runId, JSON.stringify(files))
  }

  appendItem(
    sessionId: string,
    window: number,
    owner: { readonly runId: string; readonly model: string | null; readonly agentTitle?: string } | null,
    body: ItemBody,
  ): Item {
    if (body.kind === "assistant") return this.appendAssistant(sessionId, window, owner!, body.message, null).item
    if (body.kind === "result") return this.appendToolResult(sessionId, window, owner!, body, null)
    const content = body.kind === "component" ? { kind: "component", component: body.component } : body
    const entry = this.appendEntry(sessionId, window, owner, body.kind === "component" ? "developer" : "user", content)
    const profile = this.sessionProfile(sessionId)
    return {
      ...body,
      entryId: entry.entryId,
      position: entry.position,
      runId: owner?.runId ?? null,
      model: owner?.model ?? profile.modelId,
      agentTitle: owner?.agentTitle ?? profile.agentTitle,
      contentId: entry.contentId,
      modelCallId: null,
      authorshipSessionId: sessionId,
      ownershipKind: "local",
      sourceSessionId: null,
      contentFormat: JSON_FORMAT,
      representationId: entry.contentId,
    }
  }

  appendAssistant(
    sessionId: string,
    window: number,
    owner: { readonly runId: string; readonly model: string | null; readonly agentTitle?: string },
    message: AIMessage,
    modelCallId: string | null,
  ): { readonly item: Item; readonly toolInvocationIds: ReadonlyArray<string> } {
    const content: AssistantContent = {
      messageId: message.id ?? null,
      text: textContent(message),
      content: typeof message.content === "string" ? message.content : message.content,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
    }
    const entry = this.appendEntry(sessionId, window, owner, "agent", content, { format: ASSISTANT_FORMAT, modelCallId })
    const thought = reasoningText(message)
    if (thought !== "") this.appendEntry(sessionId, window, owner, "thought", { kind: "thought", text: thought }, { modelCallId })
    const toolInvocationIds: Array<string> = []
    for (const call of message.tool_calls ?? []) {
      const tool = this.appendEntry(sessionId, window, owner, "tool", { kind: "tool", arguments: call.args }, { modelCallId })
      toolInvocationIds.push(tool.entryId)
      this.db
        .query(
          `INSERT INTO agent_tools
            (session_id, entry_id, model_call_id, model_call_unavailable, provider_call_id, parent_invocation_id, name, arguments_ref)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          sessionId,
          tool.entryId,
          modelCallId,
          modelCallId === null ? "model call unavailable" : null,
          call.id ?? null,
          call.name,
          tool.contentId,
        )
    }
    const profile = this.sessionProfile(sessionId)
    return {
      toolInvocationIds,
      item: {
      kind: "assistant",
      message,
      entryId: entry.entryId,
      position: entry.position,
      runId: owner.runId,
      model: owner.model,
      agentTitle: owner.agentTitle ?? profile.agentTitle,
      contentId: entry.contentId,
      modelCallId,
      authorshipSessionId: sessionId,
      ownershipKind: "local",
      sourceSessionId: null,
      contentFormat: ASSISTANT_FORMAT,
      representationId: entry.contentId,
      },
    }
  }

  appendToolResult(
    sessionId: string,
    window: number,
    owner: { readonly runId: string; readonly model: string | null; readonly agentTitle?: string },
    result: { readonly callId: string; readonly name: string; readonly content: ToolContent; readonly outcome: ToolOutcome },
    modelCallId: string | null,
    invocationId?: string,
  ): Item {
    const existing = invocationId === undefined
      ? this.db
          .query<{ entry_id: string; content_sha256: string; position: number; agent_title: string }, [string, string, string]>(
            `SELECT a.entry_id, e.content_sha256, e.position, e.agent_title FROM agent_tools a
              JOIN session_entries e ON e.session_id = a.session_id AND e.entry_id = a.entry_id
              WHERE a.session_id = ? AND a.model_call_id = ? AND a.provider_call_id = ? AND a.settled_at IS NULL
              ORDER BY e.position LIMIT 1`,
          )
          .get(sessionId, modelCallId ?? "", result.callId)
      : this.db
          .query<{ entry_id: string; content_sha256: string; position: number; agent_title: string }, [string, string, string]>(
            `SELECT a.entry_id, e.content_sha256, e.position, e.agent_title FROM agent_tools a
              JOIN session_entries e ON e.session_id = a.session_id AND e.entry_id = a.entry_id
              WHERE a.session_id = ? AND a.entry_id = ? AND a.model_call_id = ?`,
          )
          .get(sessionId, invocationId, modelCallId ?? "")
    let entry = existing
    if (entry === null) {
      const created = this.appendEntry(
        sessionId,
        window,
        owner,
        "tool",
        { kind: "result", callId: result.callId, name: result.name, content: result.content, outcome: result.outcome },
        { modelCallId },
      )
      this.db
        .query(
          `INSERT INTO agent_tools
            (session_id, entry_id, model_call_id, model_call_unavailable, provider_call_id, parent_invocation_id, name, arguments_ref)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          sessionId,
          created.entryId,
          modelCallId,
          modelCallId === null ? "model call unavailable" : null,
          result.callId,
          result.name,
          created.contentId,
        )
      entry = { entry_id: created.entryId, content_sha256: created.contentId, position: created.position, agent_title: "" }
    }
    const now = Date.now()
    const resultRef = this.putJson({
      kind: "result",
      callId: result.callId,
      name: result.name,
      content: result.content,
      outcome: result.outcome,
    })
    this.db
      .query(
        `UPDATE agent_tools SET started_at = coalesce(started_at, ?), settled_at = ?, outcome = ?, result_ref = ?
          WHERE session_id = ? AND entry_id = ?`,
      )
      .run(now, now, result.outcome, resultRef, sessionId, entry.entry_id)
    this.db
      .query("UPDATE session_entries SET content_sha256 = ? WHERE session_id = ? AND entry_id = ?")
      .run(resultRef, sessionId, entry.entry_id)
    const profile = this.sessionProfile(sessionId)
    return {
      kind: "result",
      callId: result.callId,
      name: result.name,
      content: result.content,
      outcome: result.outcome,
      cleared: false,
      entryId: entry.entry_id,
      position: entry.position,
      runId: owner.runId,
      model: owner.model,
      agentTitle: entry.agent_title || profile.agentTitle,
      contentId: resultRef,
      modelCallId,
      authorshipSessionId: sessionId,
      ownershipKind: "local",
      sourceSessionId: null,
      contentFormat: JSON_FORMAT,
      representationId: resultRef,
    }
  }

  markToolStarted(sessionId: string, invocationId: string, startedAt: number) {
    this.db
      .query("UPDATE agent_tools SET started_at = coalesce(started_at, ?) WHERE session_id = ? AND entry_id = ?")
      .run(startedAt, sessionId, invocationId)
  }

  knownStates(sessionId: string, window: number): SourceStates {
    const known: Partial<Record<SourceName, unknown>> = {}
    for (const item of this.items(sessionId, window)) {
      if (item.kind === "component") Object.assign(known, item.component.sources)
    }
    return known as SourceStates
  }

  putContent(sha256: string, data: string | Uint8Array, format = "text/plain"): string {
    this.db
      .query("INSERT INTO contents (sha256, data, format) VALUES (?, ?, ?) ON CONFLICT (sha256) DO NOTHING")
      .run(sha256, typeof data === "string" ? Buffer.from(data, "utf8") : data, format)
    return sha256
  }

  contentBytes(sha256: string): Uint8Array | null {
    return this.db.query<{ data: Uint8Array }, [string]>("SELECT data FROM contents WHERE sha256 = ?").get(sha256)?.data ?? null
  }

  content(sha256: string): string | null {
    const data = this.contentBytes(sha256)
    return data === null ? null : Buffer.from(data).toString("utf8")
  }

  retainedContent(sessionId: string, contentId: string, referenceId: string): RetainedContent | null {
    const attachment = this.db
      .query<{ name: string; format: string; mime_type: string; size: number }, [string, string, string]>(
        `SELECT u.name, a.format, a.mime_type, a.size
          FROM attachment_references r
          JOIN attachments a ON a.id = r.attachment_id
          JOIN uploads u ON u.attachment_id = a.id
          WHERE r.session_id = ? AND r.reference_id = ? AND a.content_sha256 = ?
          ORDER BY r.created_at LIMIT 1`,
      )
      .get(sessionId, referenceId, contentId)
    const entry = this.db
      .query<{ format: string }, [string, string, string]>(
        `SELECT c.format FROM session_entries e JOIN contents c ON c.sha256 = e.content_sha256
          WHERE e.session_id = ? AND e.entry_id = ? AND e.content_sha256 = ?`,
      )
      .get(sessionId, referenceId, contentId)
    const rendered = this.db
      .query<{ content_ref: string }, [string, string, string]>(
        `SELECT content_ref FROM request_manifest_rendered
          WHERE session_id = ? AND manifest_id = ? AND content_ref = ?`,
      )
      .get(sessionId, referenceId, contentId)
    if (attachment === null && entry === null && rendered === null) return null
    const content = this.db
      .query<{ format: string; size: number }, [string]>(
        "SELECT format, length(data) AS size FROM contents WHERE sha256 = ?",
      )
      .get(contentId)
    if (content === null) {
      return { contentId, referenceId, sessionId, available: false, representations: [] }
    }
    const format = attachment?.format ?? entry?.format ?? content.format
    const kind = format.startsWith("image/")
      ? "image"
      : format === "application/pdf"
        ? "pdf-page"
        : format === "text/plain"
          ? "text"
          : "original"
    return {
      contentId,
      referenceId,
      sessionId,
      available: true,
      representations: [
        {
          representationId: contentId,
          kind,
          mediaType: attachment?.mime_type ?? format,
          digest: contentId,
          byteLength: attachment?.size ?? content.size,
          filename: attachment?.name ?? referenceId,
          page: null,
          transformation: null,
        },
      ],
    }
  }

  addWaiting(sessionId: string, entry: NewWaitingEntry, createdAt: number): WaitingEntry {
    const position =
      (this.db.query<{ p: number | null }, [string]>("SELECT max(position) AS p FROM waiting_input WHERE session_id = ?").get(sessionId)?.p ?? 0) + 1
    const { kind, ...body } = entry
    const selection = entry.kind === "user" ? entry.selection : undefined
    this.db
      .query(
        `INSERT INTO waiting_input
          (session_id, position, input_id, kind, body, agent_title_change, model_settings_change,
           delivery_metadata, provenance, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        position,
        entry.inputId,
        kind,
        JSON.stringify(body),
        selection?.agentTitle ?? null,
        selection?.modelSettings === undefined ? null : JSON.stringify(selection.modelSettings),
        JSON.stringify(
          entry.kind === "user"
            ? { mode: entry.mode }
            : { trigger: entry.trigger, ...(entry.workflowId === undefined ? {} : { workflowId: entry.workflowId }) },
        ),
        entry.kind === "user" ? JSON.stringify(entry.sender) : null,
        createdAt,
      )
    return { ...entry, position } as WaitingEntry
  }

  waiting(sessionId: string): ReadonlyArray<WaitingEntry> {
    return this.db
      .query<{
        position: number
        kind: WaitingEntry["kind"]
        body: string
        agent_title_change: string | null
        model_settings_change: string | null
      }, [string]>(
        `SELECT position, kind, body, agent_title_change, model_settings_change FROM waiting_input
          WHERE session_id = ? ORDER BY position`,
      )
      .all(sessionId)
      .map((row) => {
        const body = JSON.parse(row.body)
        if (row.kind === "user") {
          const modelSettings = row.model_settings_change === null ? undefined : JSON.parse(row.model_settings_change)
          const selection =
            row.agent_title_change === null && modelSettings === undefined
              ? undefined
              : {
                  ...(row.agent_title_change === null ? {} : { agentTitle: row.agent_title_change }),
                  ...(modelSettings === undefined ? {} : { modelSettings }),
                }
          return { position: row.position, kind: row.kind, ...body, ...(selection === undefined ? {} : { selection }) }
        }
        return { position: row.position, kind: row.kind, ...body }
      })
  }

  sessionsWaiting(): ReadonlyArray<string> {
    return this.db
      .query<{ session_id: string }, []>("SELECT session_id FROM waiting_input GROUP BY session_id ORDER BY min(created_at), session_id")
      .all()
      .map((row) => row.session_id)
  }

  removeWaiting(sessionId: string, position: number) {
    this.db.query("DELETE FROM waiting_input WHERE session_id = ? AND position = ?").run(sessionId, position)
  }

  clearWaiting(sessionId: string): ReadonlyArray<string> {
    const ids = this.waiting(sessionId).map((entry) => entry.inputId)
    this.db.query("DELETE FROM waiting_input WHERE session_id = ?").run(sessionId)
    if (ids.length > 0) {
      this.db
        .query(
          `DELETE FROM attachment_references WHERE session_id = ?
            AND reference_id IN (SELECT value FROM json_each(?))`,
        )
        .run(sessionId, JSON.stringify(ids))
    }
    return ids
  }

  removeWaitingWorkflow(sessionId: string, workflowId: string) {
    this.db
      .query(
        `DELETE FROM waiting_input WHERE session_id = ? AND kind = 'notification'
          AND json_extract(delivery_metadata, '$.workflowId') = ?`,
      )
      .run(sessionId, workflowId)
  }

  copy(source: string, target: string, runIds: ReadonlyArray<string>) {
    const kept = JSON.stringify(runIds)
    this.db
      .query(
        `INSERT INTO checkpoint_windows
          (session_id, position, run_id, harness_instructions, harness_content_sha256, created_at)
          SELECT ?, position, run_id, harness_instructions, harness_content_sha256, created_at
          FROM checkpoint_windows WHERE session_id = ? AND (run_id IS NULL OR run_id IN (SELECT value FROM json_each(?)))`,
      )
      .run(target, source, kept)
    this.db
      .query(
        `INSERT INTO model_calls
          (session_id, model_call_id, turn_id, ordinal, window_position, input_manifest_ref,
           offered_tools_ref, started_at, ended_at, outcome, provider_replay_ref)
          SELECT ?, model_call_id, turn_id, ordinal, window_position, input_manifest_ref,
            offered_tools_ref, started_at, ended_at, outcome, provider_replay_ref
          FROM model_calls WHERE session_id = ? AND turn_id IN (SELECT value FROM json_each(?))`,
      )
      .run(target, source, kept)
    this.db
      .query(
        `INSERT INTO request_manifests (session_id, manifest_id, model_call_id, body_ref, created_at)
          SELECT ?, manifest_id, model_call_id, body_ref, created_at FROM request_manifests
          WHERE session_id = ? AND model_call_id IN (SELECT model_call_id FROM model_calls WHERE session_id = ?)`,
      )
      .run(target, source, target)
    this.db
      .query(
        `INSERT INTO request_manifest_rendered (session_id, manifest_id, content_ref)
          SELECT ?, manifest_id, content_ref FROM request_manifest_rendered
          WHERE session_id = ? AND manifest_id IN (SELECT manifest_id FROM request_manifests WHERE session_id = ?)`,
      )
      .run(target, source, target)
    this.db
      .query(
        `INSERT INTO session_entries
          (session_id, entry_id, position, owner_turn_id, kind, content_sha256, model_call_id,
           agent_title, model_id, authorship_session_id, ownership_kind, source_session_id,
           source_entry_id, created_at)
          SELECT ?, entry_id, position, owner_turn_id, kind, content_sha256, model_call_id,
            agent_title, model_id, authorship_session_id,
            CASE ownership_kind WHEN 'local' THEN 'inherited' ELSE ownership_kind END,
            CASE ownership_kind WHEN 'local' THEN ? ELSE source_session_id END,
            CASE ownership_kind WHEN 'local' THEN entry_id ELSE source_entry_id END,
            created_at
          FROM session_entries WHERE session_id = ? AND (owner_turn_id IS NULL OR owner_turn_id IN (SELECT value FROM json_each(?)))`,
      )
      .run(target, source, source, kept)
    this.db
      .query(
        `INSERT INTO window_entries (session_id, window_position, entry_id)
          SELECT ?, w.window_position, w.entry_id FROM window_entries w
          WHERE w.session_id = ? AND w.entry_id IN (SELECT entry_id FROM session_entries WHERE session_id = ?)`,
      )
      .run(target, source, target)
    this.db
      .query(
        `INSERT INTO agent_tools
          (session_id, entry_id, model_call_id, model_call_unavailable, provider_call_id, parent_invocation_id, name,
           arguments_ref, started_at, settled_at, outcome, result_ref)
          SELECT ?, entry_id, model_call_id, model_call_unavailable, provider_call_id, parent_invocation_id, name,
            arguments_ref, started_at, settled_at, outcome, result_ref
          FROM agent_tools WHERE session_id = ? AND entry_id IN (SELECT entry_id FROM session_entries WHERE session_id = ?)`,
      )
      .run(target, source, target)
    this.db
      .query(
        `INSERT INTO context_result_replacements (session_id, entry_id, run_id, attempt, replacement_ref)
          SELECT ?, entry_id, run_id, attempt, replacement_ref FROM context_result_replacements
          WHERE session_id = ? AND entry_id IN (SELECT entry_id FROM session_entries WHERE session_id = ?)`,
      )
      .run(target, source, target)
    this.db
      .query(
        `INSERT INTO research_baselines (session_id, position, window_position, run_id, files)
          SELECT ?, position, window_position, run_id, files FROM research_baselines
          WHERE session_id = ? AND window_position IN (SELECT position FROM checkpoint_windows WHERE session_id = ?)`,
      )
      .run(target, source, target)
    this.db
      .query(
        `INSERT INTO snapshot_files (session_id, run_id, area, name, sha256)
          SELECT ?, run_id, area, name, sha256 FROM snapshot_files WHERE session_id = ? AND run_id IN (SELECT value FROM json_each(?))`,
      )
      .run(target, source, kept)
    this.db
      .query(
        `INSERT INTO attachment_references (attachment_id, session_id, kind, reference_id, created_at)
          SELECT r.attachment_id, ?, r.kind, r.reference_id, r.created_at FROM attachment_references r
          WHERE r.session_id = ? AND r.reference_id IN (
            SELECT input_id FROM turn_inputs WHERE session_id = ? UNION SELECT entry_ref FROM turn_inputs WHERE session_id = ?
          )`,
      )
      .run(target, source, target, target)
  }
}
