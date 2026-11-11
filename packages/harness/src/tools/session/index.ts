import { accessSync, constants, statSync } from "node:fs"
import { Schema } from "effect"
import type { SelectionPatch } from "@ashe-agent/protocol"
import { RetainedAttachmentRef } from "@ashe-agent/protocol"
import { builtinTool, type Tool, type ToolResult, type ToolRun, type ToolExecutionPolicy } from "../../agent/tools.ts"
import { endSpan, startSpan, type ErrorClass } from "../../telemetry/signals.ts"

const Empty = Schema.Record(Schema.String, Schema.Never)
const SessionId = Schema.NonEmptyString
const MessageCategory = Schema.Literals(["user", "agent_intermediate", "agent_final"])
const MessageCategories = Schema.NonEmptyArray(MessageCategory).check(Schema.isUnique())

const MessageArgs = Schema.Struct({
  sessionId: Schema.optionalKey(SessionId),
  text: Schema.NonEmptyString,
  attachments: Schema.optionalKey(Schema.Array(RetainedAttachmentRef)),
  selection: Schema.optionalKey(Schema.Struct({
    agentTitle: Schema.optionalKey(Schema.NonEmptyString),
    modelSettings: Schema.optionalKey(Schema.Struct({
      modelId: Schema.optionalKey(Schema.NullOr(SessionId)),
      reasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.String)),
    })),
  })),
  subscribe: Schema.optionalKey(Schema.Struct({
    messages: Schema.optionalKey(MessageCategories),
  })),
})

const SubscriptionArgs = Schema.Struct({
  sourceSessionId: SessionId,
  action: Schema.Literals(["subscribe", "unsubscribe"]),
  messages: Schema.optionalKey(MessageCategories),
})

const WaitArgs = Schema.Struct({
  timeout_ms: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
})

/** What the session tools need from the coordinator. */
export interface SessionToolHost {
  readonly databasePath: string
  readonly sqlite3Path: string
  readonly communicationWaitMinMs: number
  readonly communicationWaitDefaultMs: number
  readonly communicationWaitMaxMs: number
  readonly toolPolicy: ToolExecutionPolicy
  message(run: ToolRun, args: typeof MessageArgs.Type): Promise<ToolResult>
  forkSession(run: ToolRun): Promise<ToolResult>
  subscription(run: ToolRun, args: typeof SubscriptionArgs.Type): Promise<ToolResult>
  wait(run: ToolRun, args: typeof WaitArgs.Type): Promise<ToolResult>
  listSessions(run: ToolRun): ToolResult
}

const selectionSubjects = (selection: SelectionPatch | undefined) =>
  selection?.agentTitle === undefined ? [] : [selection.agentTitle]

const observed = async (
  action: "message" | "subscribe" | "unsubscribe" | "fork" | "wait" | "list",
  call: () => Promise<ToolResult>,
): Promise<ToolResult> => {
  const span = startSpan("ashe_agent.communication", { "ashe_agent.communication.action": action })
  let failure: ErrorClass | undefined
  try {
    const result = await call()
    if (result.outcome === "failed") failure = "internal"
    return result
  } catch (error) {
    failure = "internal"
    throw error
  } finally {
    endSpan(span, {}, failure)
  }
}

/** The five direct-only session tools. */
export const sessionTools = (host: SessionToolHost): ReadonlyArray<Tool> => [
  builtinTool({
    namespace: "session",
    name: "message",
    permission: "session",
    description: "Message a session.",
    args: MessageArgs,
    prepare: (args) => {
      const subjects = [args.sessionId ?? "new", ...selectionSubjects(args.selection)]
      return { check: { permission: "session", subjects, patterns: subjects }, plan: undefined }
    },
    run: (args, run) => observed("message", () => host.message(run, args)),
  }),
  builtinTool({
    namespace: "session",
    name: "fork",
    permission: "session",
    defer: "fork",
    description: "Fork this session; first call wins.",
    args: Empty,
    prepare: (_args, run) => {
      const subjects = [run.sessionId]
      return { check: { permission: "session", subjects, patterns: subjects }, plan: undefined }
    },
    run: (_args, run) => observed("fork", () => host.forkSession(run)),
  }),
  builtinTool({
    namespace: "session",
    name: "subscription",
    permission: "session",
    description: "Change a session subscription.",
    args: SubscriptionArgs,
    prepare: (args) => {
      const subjects = [args.sourceSessionId]
      return { check: { permission: "session", subjects, patterns: subjects }, plan: undefined }
    },
    run: (args, run) => observed(args.action === "subscribe" ? "subscribe" : "unsubscribe", () => host.subscription(run, args)),
  }),
  builtinTool({
    namespace: "session",
    name: "wait",
    permission: "session",
    description: "Wait for activity.",
    args: WaitArgs,
    prepare: (_args, run) => {
      const subjects = [run.sessionId]
      return { check: { permission: "session", subjects, patterns: subjects }, plan: undefined }
    },
    run: (args, run) => observed("wait", () => host.wait(run, args)),
  }),
  builtinTool({
    namespace: "session",
    name: "list",
    permission: "session",
    description: "List sessions and database queries.",
    args: Empty,
    prepare: (_args, run) => {
      const subjects = [run.sessionId]
      return { check: { permission: "session", subjects, patterns: subjects }, plan: undefined }
    },
    run: (_args, run) => observed("list", () => Promise.resolve(host.listSessions(run))),
  }),
]

/** The bounded read-only discovery command included with every session list result. */
export const databaseGuide = (sqlite3Path: string, databasePath: string) => {
  let available = false
  try {
    available = statSync(sqlite3Path).isFile()
    if (available) accessSync(sqlite3Path, constants.X_OK)
  } catch {
    available = false
  }
  const query = (name: string, columns: ReadonlyArray<string>, sql: string) => ({
    name,
    columns,
    sql,
    limit: 100,
    command: `${JSON.stringify(sqlite3Path)} -readonly ${JSON.stringify(databasePath)} ${JSON.stringify(sql)}`,
  })
  const queries = [
    query(
      "current settings",
      ["id", "agent_title", "model_id", "reasoning_effort", "next_seq"],
      "SELECT s.id, ss.agent_title, ss.model_id, ss.reasoning_effort, s.next_seq FROM sessions s JOIN session_settings ss ON ss.session_id = s.id AND ss.revision = s.current_settings_revision ORDER BY s.created_at, s.id LIMIT 100",
    ),
    query(
      "conversation history",
      ["session_id", "position", "kind", "entry_id", "content_sha256", "preview", "created_at"],
      "SELECT e.session_id, e.position, e.kind, e.entry_id, e.content_sha256, substr(cast(c.data AS TEXT), 1, 400) AS preview, e.created_at FROM session_entries e JOIN contents c ON c.sha256 = e.content_sha256 ORDER BY e.session_id, e.position DESC LIMIT 100",
    ),
    query(
      "historical turns",
      ["session_id", "run_id", "status", "started_at", "ended_at"],
      "SELECT session_id, run_id, status, started_at, ended_at FROM turns ORDER BY session_id, position DESC LIMIT 100",
    ),
    query(
      "waiting input",
      ["session_id", "position", "input_id", "kind", "mode", "trigger", "body_preview", "created_at"],
      "SELECT session_id, position, input_id, kind, json_extract(delivery_metadata, '$.mode') AS mode, json_extract(delivery_metadata, '$.trigger') AS trigger, substr(body, 1, 2000) AS body_preview, created_at FROM waiting_input ORDER BY session_id, position LIMIT 100",
    ),
    query(
      "context workflows",
      ["id", "session_id", "trigger", "current_turn_id", "created_at", "ended_at"],
      "SELECT id, session_id, trigger, current_turn_id, created_at, ended_at FROM context_workflows ORDER BY created_at DESC LIMIT 100",
    ),
    query(
      "pending restores",
      ["session_id", "created_at", "area", "name", "content_sha256"],
      "SELECT r.session_id, r.created_at, f.area, f.name, f.sha256 AS content_sha256 FROM pending_restores r LEFT JOIN pending_restore_files f ON f.session_id = r.session_id ORDER BY r.created_at DESC, f.area, f.name LIMIT 100",
    ),
  ]
  return {
    sqlite3: sqlite3Path,
    database: databasePath,
    available,
    readOnly: true,
    command: queries[0]!.command,
    activityQuery: queries[2]!.command,
    queries,
    guidance:
      `${available ? "" : `The official sqlite3 executable is unavailable at ${sqlite3Path}. `}The queries cover sessions and session_settings, session_entries and contents, turns, waiting_input, context_workflows, and pending_restores with pending_restore_files. Preview columns are bounded; turns.status describes historical settlement and stored running rows do not prove process liveness after a crash. Current activity is the coordinator's live loop plus eligible waiting input. Each query is bounded to 100 rows. Query only with sqlite3 -readonly; all mutations belong to harness operations.`,
  }
}
