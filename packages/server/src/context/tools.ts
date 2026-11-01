import { Schema } from "effect"
import { builtinTool, type Tool, type ToolResult, type ToolRun } from "../agent/tools.ts"
import type { AppendInput } from "./entries.ts"

/** The context tools that no permission rule applies to. */
export const UNCHECKED_CONTEXT_TOOLS: ReadonlyArray<string> = ["context_append", "context_get_open_items"]

/** The tools a context turn's model calls offer after its first clearing, as far as the session offers them. */
export const CLEARED_CONTEXT_TOOLS: ReadonlyArray<string> = [
  "context_append",
  "context_get_open_items",
  "shell_exec_command",
  "shell_write_stdin",
  "file_read",
  "file_patch",
]

/** The permission `context_ask_question` calls are decided under, and withheld by. */
export const ASK_PERMISSION = "context_ask_question"

const APPEND_DESCRIPTION = `Appends 1 to 16 entries to this session's primary timeline. The timelines carry your work into later checkpoint windows; most else in this checkpoint window will be gone from your context. Record entries as you work, without waiting to be asked.

- \`open\` (\`Text\`): work that remains, such as a step you will take later or a follow-up a finding calls for.
- \`done\` (\`Text\`, optional \`resolves\`): work you finished, such as a passing test run or a pushed branch, for any of the tasks at hand. \`resolves\` lists the numbers of the open and problem entries it settles; the harness restates each under the entry.
- \`decision\` (\`Decision\`, \`Rationale\`): when you choose an approach, a value, or a scope that later work depends on.
- \`problem\` (\`Text\`): when an obstacle blocks the task or puts it at risk. Resolve it with a \`done\` entry once it no longer does.

Each text field holds 1 to 120 characters. Write each entry so it makes sense without the rest of this checkpoint window: name files, commands, values, and identifiers exactly. Record each fact once. A call with an invalid entry appends none. The result is the entries as recorded, with their numbers. Changes to \`research/\` need no entry; the harness records them.`

const OPEN_ITEMS_DESCRIPTION =
  "Lists this session's open and problem entries that no `done` entry has resolved, oldest first, wherever they are: those still in the primary timeline and those trimmed into secondary timelines."

const ASK_DESCRIPTION = `Asks the user one to three short questions and waits for the answers. Ask when a choice is the user's to make and later work depends on it; otherwise make a reasonable choice and state it. Never ask for secrets: answers are recorded in the primary timeline. Not available in a context turn.

Give each question 2 or 3 mutually exclusive options, the recommended one first with "(Recommended)" ending its label. The user may select one, add a note, answer only in a note, or skip; never add an "Other" option. Write each question and option so it makes sense on its own later.

When this call follows earlier questions, use \`feedback\` to respond to their answers, such as what a selection implies or where you disagree; the user sees it before these questions.

The result holds the answers as \`[ANSWER]\` entries with their numbers and names any skipped question. If the user sends a message instead of answering, the result says so and the message follows.`

const Text = Schema.String

const AppendEntry = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("open"), Text }),
  Schema.Struct({ kind: Schema.Literal("done"), Text, resolves: Schema.optionalKey(Schema.Array(Schema.Int)) }),
  Schema.Struct({ kind: Schema.Literal("decision"), Decision: Text, Rationale: Text }),
  Schema.Struct({ kind: Schema.Literal("problem"), Text }),
])

const described = <S extends Schema.Top>(schema: S, description: string) => schema.annotate({ description }) as S

const AskArgs = Schema.Struct({
  feedback: Schema.optionalKey(
    described(Schema.String, "Your response to the user's answers to your previous questions, shown before these. Leave it out on a first call."),
  ),
  questions: described(
    Schema.Array(
      Schema.Struct({
        id: described(Schema.String, "A stable snake_case identifier for the question."),
        header: described(Schema.String, "A label of at most 12 characters for the question."),
        question: described(Schema.String, "One sentence of at most 240 characters."),
        options: described(
          Schema.Array(
            Schema.Struct({
              label: described(Schema.String, "One to five words, at most 40 characters."),
              description: described(Schema.String, "One sentence on the choice's effect, at most 120 characters."),
            }),
          ),
          "Two or three mutually exclusive choices, the recommended one first.",
        ),
      }),
    ),
    "One to three questions; prefer one.",
  ),
})

/** The arguments of a `context_ask_question` call, as they decode. */
export type AskArgs = typeof AskArgs.Type

/** What the context tools do, given by the session hub. */
export interface ContextToolPort {
  readonly append: (run: ToolRun, entries: ReadonlyArray<AppendInput>) => ToolResult
  readonly openItems: (run: ToolRun) => ToolResult
  /** A result that ends the call before its authorization, such as a refusal in a context turn, or null to go on. */
  readonly refuseAsk: (run: ToolRun, args: AskArgs) => ToolResult | null
  readonly ask: (run: ToolRun, args: AskArgs) => Promise<ToolResult>
}

/**
 * The built-in `context` namespace: `context_append` and
 * `context_get_open_items`, which ask no permission, and
 * `context_ask_question`, decided under its own permission.
 */
export const contextTools = (port: ContextToolPort): ReadonlyArray<Tool> => [
  builtinTool({
    namespace: "context",
    name: "append",
    permission: null,
    description: APPEND_DESCRIPTION,
    args: Schema.Struct({ entries: Schema.Array(AppendEntry) }),
    run: async ({ entries }, run) => port.append(run, entries),
  }),
  builtinTool({
    namespace: "context",
    name: "get_open_items",
    permission: null,
    description: OPEN_ITEMS_DESCRIPTION,
    args: Schema.Struct({}),
    run: async (_, run) => port.openItems(run),
  }),
  builtinTool({
    namespace: "context",
    name: "ask_question",
    permission: ASK_PERMISSION,
    description: ASK_DESCRIPTION,
    args: AskArgs,
    prepare: (args, run) => port.refuseAsk(run, args) ?? { check: { permission: ASK_PERMISSION, subjects: [], patterns: ["*"] }, plan: undefined },
    run: (args, run) => port.ask(run, args),
  }),
]
