# Model context

This page explains what each model call of a turn carries, how a
session's conversation reaches the model, and when the turn loop records
it.

## Checkpoint windows

A session's model context is its current checkpoint window: the harness
instructions and a list of items. An item is a developer component, a
user message, an assistant message, or a tool result. A session's first
checkpoint window is built when the session is created: its harness
instructions, from `packages/server/src/context/harness.md`, and its
seed, the developer components that open it. Every model call of a turn
sends the whole window, rendered for the turn's model. A context turn
builds each later checkpoint window, as
[later checkpoint windows](#later-checkpoint-windows) explains.

Creation fails, naming what is too large, its estimated tokens, and its
allowance, when the harness instructions, a seed component, or the tool
definitions the session is offered exceed their allowance. Tokens are
estimated at one per four characters. The allowances live in
`packages/server/src/context/constants.ts`. Creation also fails, naming
the file and the reason, when the session's chosen user instructions
file exists but cannot be read.

## The turn loop

A turn runs as a loop in its own Effect fiber, with no step limit. Each
step is a model call, then the tool calls it made, one after another in
the order the model made them. A step boundary comes after the results
of a step's tool calls and after a reply without tool calls. At a step
boundary, steered user messages and notification components that are
waiting join the turn. After a reply without tool calls, the turn ends
when nothing joins; a plain reject also ends it.

The loop records the conversation as it goes. An assistant message is
committed as an item in one transaction with the events that end its
model call's streams, each tool result with its `TOOL_CALL_RESULT` event,
and each user message with its `INPUT_RECEIVED` event. A model call that
the provider fails as exceeding the context window reaches the
[context limit](#the-context-limit).

Before each model call, the loop checks the definitions of the tools
offered now against their allowance; over it, such as after an MCP
server's tools arrive, the call is not sent, and the turn fails with an
error event naming the tool definitions, their estimated tokens, and the
allowance.

The loop receives the fiber's `AbortSignal`. A cancel interrupts the
fiber, which aborts the running model call and tool call, ends the open
text, reasoning, and tool call streams, and gives every tool call of the
turn without a result a canceled result saying whether it had started.
A turn that fails gives each of its tool calls without a result a failed
result the same way. At server start, each tool call of a turn left
running without a result gets an interrupted result, in one transaction
with the turn's `RUN_INTERRUPTED` event. A result is recorded as an item
for each call a committed assistant message holds; a call that a model
call streamed before it failed or was canceled gets its result event
only, since the model never receives that call.

## Model calls

Model calls use the OpenAI Responses API at the base URL of the turn's
model's provider, with that provider's API key and its own id of the
model, through LangChain's `ChatOpenAI`. Each call asks the provider not to store it, so it carries
its whole input, and requests reasoning with its encrypted content, so
later calls of the same model can send that reasoning back. Every call
sets `instructions` to the fixed line `You're a helpful assistant.`.

A call to a model that lists reasoning efforts sends the `reasoning`
field with `summary: "auto"` and, when one resolves, the `effort`: the
session's selection when the turn started, else the agent's override for
the model, else the model entry's setting, each only if the model lists
it. A call to a model without reasoning efforts sends no `reasoning`
field. A call sends a temperature only to a model that accepts one: the
agent's override, else the model entry's setting.
[Configuration](configuration.md) explains the model entries.

The server reads no `OPENAI_*`, `LANGCHAIN_*`, `LANGSMITH_*`, or `LC_*`
process variable: `serve` removes them before the turn loop starts, so the libraries cannot take configuration or tracing
settings from them.

## Blocks

The conversation reaches the model in tagged blocks inside user inputs,
each standing for an identity:

- `<system>` holds the checkpoint window's harness instructions, which
  nothing in a session changes.
- `<developer>` holds a developer message: one or more adjoining
  developer components, each under its own `#` heading.
- `<user>` holds one user message.

The first user input of every call opens with the `<system>` block. Each
run of consecutive items that are developer components or user messages
forms one user input, in which adjoining components form one
`<developer>` block. Assistant messages, tool calls, and their results use
the Responses API's message, function call, and function call output
items, never blocks.

The server escapes each literal `<system>`, `</system>`, `<developer>`,
`</developer>`, `<user>`, and `</user>` in the text it places in a
`<developer>` or `<user>` block as `&lt;…>`, so only the server opens and closes blocks. Headings
inside user instructions and catalogs are lowered one level, so they sit
below their component's heading.

A tool result's images reach the model as images only when the turn's
model takes image input; otherwise each becomes `[image: <path>]`.

## Developer components

A developer component is typed by how it is injected:

- A seed component is rendered when a checkpoint window is built: the
  user instructions, the skill catalog, the code mode catalog, and the
  session facts, in that order, each left out when it has no content.
  The session facts give the session id, the agent's display title, the
  server's date in its own time zone and the user's date in the
  configured user time zone, UTC by default, and no path.
- A state component rides on a delivery of user messages or notification
  components, and never starts a turn.
- A notification component, such as the one a rewind queues, joins the
  running turn at its next step boundary, or starts a turn in an idle
  session. Scratch lost and memory restored components report a lost
  scratch target and a republished memory generation; a rewind or fork
  whose kept history predates such a report queues it again, without the
  memory paths.

Each delivery reconciles the sources the components describe: for each
of the user instructions, the skill catalog, the code mode catalog, the
session identity, and the dates whose current state differs from the
state the checkpoint window knows, it yields one state component. The
known state is the one the window's latest kept component of that source
established. A delivery keeps its notification components and user
messages in arrival order and places its state components before its
first user message. [Sessions](sessions.md) explains how deliveries
reach a turn.

- User instructions are compared by file metadata first and by SHA-256
  only when the metadata differs. A change within the same file arrives
  as one unified diff; a switch between the title file and the global
  file, either way, arrives as the new source's full text. A chosen file
  that exists but cannot be read yields a `SESSION_ERROR` event naming
  it, and the known instructions stay.
- A changed catalog arrives as it stands now. A catalog over its
  allowance yields a `SESSION_ERROR` event instead, and the known catalog
  stays.
- Changed dates arrive as the server's and the user's dates with their
  time zones.
- The session facts also establish the session's scratch and memory
  restore generations, and each scratch lost or memory restored component
  the generation it reports.
- A different session id, as in a fork, arrives as the fork component,
  which names the source and the new session.

The server keeps each version of the user instructions a component
establishes in its content store, by SHA-256, so the next diff has the
text it starts from.

## Other models' turns

Each turn runs every model call with the model selected when it started.
A call sends the items that model's turns made, and those of no turn,
such as the seed, as ordinary messages and items. Each run of
consecutive items other models' turns made becomes one transcript
component in the surrounding developer block: it holds each user message
as a `<user>` block, each reply as an `<agent model="…">` block, each tool
call and result as `<tool_call>` and `<tool_result>` blocks, and each
developer component as a nested `<developer>` block. A transcript leaves
out the other model's reasoning and shows each image a tool result
carried as `[image: <path>]`. Switching back to a model sends its items
as ordinary messages again.
Seed components, the session checkpoint included, are never part of a
transcript component.

## Sizes

Each model and agent pair has a checkpoint window size, which
[configuration](configuration.md) explains with the working margin it
must leave. The harness seed has allowances in estimated tokens: 4,000
for the harness instructions, 12,000 for the user instructions, 4,000
each for the skill and code mode catalogs, 2,000 for the session facts,
and 80,000 for the session checkpoint, of which 60,000 are its timelines
allowance and 20,000 its recent transcript allowance. The tool
definitions a model call offers, names, descriptions, and parameter
schemas, have an allowance of 4,000. The reserve, 40,000, is the part of
the checkpoint window size whose shortfall starts a context turn. Each
image in a call's input is estimated at 1,500 tokens.

## Timelines

A session's primary timeline is its entries, numbered from 1 in one
sequence across their kinds. The agent appends `open`, `done`,
`decision`, and `problem` entries; the harness writes `compaction`,
`research`, `answer`, and `handoff` entries. Secondary timelines are the
files in `memory/` that hold entries trimmed from the primary timeline;
the timelines are both.

An entry renders as one block: its header line, such as `[OPEN #3]`,
then each field as `<Field>: <value>` on its own line, or for a
compaction or handoff entry its text. A line of an entry's text that
reads as a header gets a leading backslash, so only header lines start
entries. A `done` entry restates each entry it resolves on a line such
as `Resolves: #3 [OPEN] Write the parser`.

`context_append` appends 1 to 16 entries. Each text field holds 1 to 120
Unicode code points on one line, and a `done` entry's optional
`resolves` lists 1 to 16 open or problem entries of the session that no
kept `done` entry resolves and no other `resolves` of the call names. A
call with an invalid entry appends none and names every problem; its
result is otherwise the entries as recorded. An open item is an `open`
or `problem` entry no `done` entry resolves, so a rewind that removes a
`done` entry reopens what it resolved. `context_get_open_items` lists
the open items oldest first, each marked as in the primary timeline or
trimmed. Neither tool is permission-checked.

Each entry emits a `TIMELINE_ENTRY` event, and each new text of a
compaction entry a `TIMELINE_ENTRY_REPLACED` event. Entries reach the
model in tool results, in a session checkpoint, and in a timelines
trimmed component.

## Questions

`context_ask_question` shows the user 1 to 3 questions, each with an
`id`, a `header` of at most 12 characters, a `question` of at most 240,
and 2 or 3 options of a `label` of 1 to 40 characters and a
`description` of 1 to 120. A call may carry `feedback` of 1 to 2,000
characters, the agent's response to the answers of its previous call;
a session that has asked no questions refuses it. The call is decided
under the `context_ask_question` permission, emits `QUESTIONS_ASKED`,
and waits without a timeout.

`session.answerQuestion` answers each question with an option's label, a
note of 1 to 2,000 characters, both, or neither, which skips it. The
first answer to a question set settles it with `QUESTIONS_ANSWERED`, and
a later one is refused. Each answered question becomes an `answer`
entry holding `Question`, `Selection` as the label and its description
joined by `: `, and `UserNote`. The call's result holds those entries and
a `Skipped:` line naming each skipped question.

A steered user message ends a waiting call with a result saying the user
replied with a message instead, and the message joins the turn at the
next step boundary; a queued message leaves the call waiting. A cancel
or a server stop ends the call without entries. A context turn refuses
the call.

## Chat boundaries and compaction entries

A chat boundary opens at a user message when none is open. Its size is
the estimated tokens of the session's items from that message on, across
checkpoint windows, leaving out seed components and the items of a
context turn from its context turn component on. It closes when its size
reaches 60,000, and the next user message opens another.

A closing starts a compaction call in the background, without delaying
turns. It runs on the `compaction` auxiliary model with the versioned
prompt `packages/server/src/context/prompts/compaction.md`, asks for at
most 8,000 output tokens, and receives the primary timeline and the
boundary's user messages and final agent messages in order. A turn that
ended by cancel, reject, failure, or server stop without a final message
has a marker naming why; tool items, developer components, and
intermediate replies are left out. The output becomes the boundary's
compaction entry, recording the prompt's revision, the first 12 hex
digits of its SHA-256.

A compaction entry covers the messages its call summarized. When a
context turn starts, a call runs for the open boundary unless its entry
covers all its messages, so a lone user message gets an entry too; a
later call for a boundary that gained messages replaces its entry's text
in place. Trimming a compaction entry closes its boundary, so a trimmed
entry keeps its latest text. A rewind or fork that commits while a
session's compaction call runs discards the call's output, and a rewind
that removes part of a boundary reopens it with its entry's text as it
stood before the removed turns.

A context turn's first trim, or its first validation when no trim comes
first, waits for the session's running compaction calls and runs each
call still due once more. When that call fails too, the turn ends with a
`compaction_failed` error naming the boundary's first user message, and
the session keeps its checkpoint window.

## Research entries

Each checkpoint window has a research baseline: the research files when
a context turn built it, empty for the first window, and after each idle
that appends research entries, the files those entries saw. When a
context turn starts, the server starts
a research call for each file created or changed against the baseline,
on the `research` auxiliary model with the versioned prompt
`packages/server/src/context/prompts/research.md`. A call receives the
file's name, change, and description, its diff from the baseline or its
content when created, each cut to 16,000 characters from each end, and
the names of the other files created and deleted. A deleted file gets no
call.

At each idle, the server starts calls for files changed since, waits for
them, and retries each failed call once; when the retry fails, the turn
ends with a `research_failed` error. It then appends one `research` entry
per file, in file name order, holding `FileName`, `Change` as `created`
or `changed`, and `Summary`, the output on one line cut at a word
boundary to 240 code points with `…`.

## Context turns

Before a model call that leaves less than the reserve within the
checkpoint window size, the server delivers a context turn component,
and the rest of the turn is a context turn, marked by
`CONTEXT_TURN_STARTED`. The server writes `memory-draft/` as a copy of
the current memory generation, and the component asks the agent to
record its state with `context_append`, to file entries in
`memory-draft/`, and to fix the research and memory problems it lists.
Research and compaction calls start with it. Until its first clearing, a
context turn offers the same tools as before.

User messages and notification components that arrive during a context
turn wait for its continuation turn, except its own components and
memory restored components.

A reply without tool calls is an idle. Each idle appends research
entries first. Then, when the primary timeline is over its allowance,
the server trims its oldest entries until the timelines part of a
session checkpoint fits 60,000 tokens: the checkpoint's heading and
introduction, the secondary timelines section, the primary timeline
section's heading and explanation, the line counting trimmed open items
when the trim leaves any, and the remaining entries. A trim delivers a
timelines trimmed component naming the trimmed range, with the stored
text of each trimmed compaction or research entry written or replaced in
the current checkpoint window, and the context turn goes on.

An idle that trims nothing validates `research/` and `memory-draft/`:

- Both hold only regular Markdown files directly inside them.
- Each research file's YAML frontmatter has a `description` string of 1
  to 120 characters on one line.
- Each secondary timeline has such a description and a path of at most
  120 characters, holds only entries identical to their stored rendering
  in number order, separated by blank lines, and every trimmed entry is
  in exactly one of them.
- `memory-draft/` holds at most 64 files.

When validation passes, the draft becomes the next memory generation and
the server builds the next checkpoint window. When it fails, a context
check failed component lists each violation, `VALIDATION_FAILED`
records them, and the context turn goes on. After the third failure,
the server falls back: a draft whose secondary timelines pass is
published; otherwise, when the context turn trimmed entries, the current
generation is published with them added as
`unsorted-<first>-<last>.md`; otherwise memory keeps its current
generation. When the memory it publishes or keeps lists secondary
timelines the draft did not, the context turn first trims further, into
the unsorted file, until the primary timeline fits beside them. The next
checkpoint window is built either way.

A context turn that ends without building the next checkpoint window,
by cancel, failure, or server stop, settles its draft as the fallback
does, without trimming further, since no checkpoint window follows. It
discards its research calls, and its held input starts a turn as queued
input does, after recovery when the server restarted.

## The context limit

A turn reaches the context limit when a model call's estimated input
reaches the checkpoint window size, or when the provider fails the call
as exceeding the context window. A turn that is no context turn becomes
one at the limit, after a first clearing.

A clearing replaces the oldest tool results of the checkpoint window,
other than `context` tool results, with
`[Result cleared to free context. Run the call again if you need it.]`,
keeping their calls, until 25%, then 50%, then all of the clearable
results' tokens before the first clearing are freed. Each emits
`TOOL_RESULTS_CLEARED`, and the model call is retried. After the first
clearing, the context turn offers only `context_append`,
`context_get_open_items`, `shell_exec_command`, `shell_write_stdin`,
`file_read`, and `file_patch`, as far as the session offers them. A call
to a tool its model call did not offer gets a failed result naming the
tools it offered.

Reaching the limit after the third clearing runs a handoff call on the
`handoff` auxiliary model with the versioned prompt
`packages/server/src/context/prompts/handoff.md`. It receives the
primary timeline and a transcript of the checkpoint window without its
seed, rendered as a transcript component renders it. A transcript over
its budget, the handoff model's checkpoint window size less the prompt,
the primary timeline, and 8,000 output tokens, is shortened oldest
exchange first: tool outputs cut to 2,000 characters from each end, then
left out, then user text only. Its output, at most 8,000 tokens, becomes
a `handoff` entry. The context turn then ends as an idle does, without a
timelines trimmed component: research entries, a trim, one validation,
and the fallback when it fails. A handoff call that fails, stops at its
output limit, or has no transcript that fits ends the turn with a
`handoff_failed` error, and the session keeps its checkpoint window.

Each auxiliary model is the configured one for its task, else the model
of the session's latest turn, with that model's own settings: the turn's
effort selection only when it is the turn's model.

## Later checkpoint windows

Building the next checkpoint window renders a fresh seed from the
current harness instructions, user instructions, catalogs, and session
facts, with the session checkpoint last. An instructions file that
cannot be read keeps the instructions the current window knows, with a
`SESSION_ERROR` event. A component over its allowance fails the
construction with `CHECKPOINT_WINDOW_FAILED` and a
`checkpoint_window_failed` error, and the session keeps its checkpoint
window. A built window belongs to the context turn, records its research
baseline, and emits `CHECKPOINT_WINDOW_SEEDED`.

The session checkpoint holds the secondary timelines with their
descriptions, the untrimmed primary timeline entries with the count of
trimmed open items, and the recent transcript. The recent transcript is
the items after the old window's last user message and before its
context turn, whole items newest first within its allowance, in their
order; it is left out when the last of those items other than a
developer component is a user message. The section explanations are
the files in `packages/server/src/context/checkpoint/`.

The continuation turn starts the new window with the continuation
component, which forms one developer message with the seed, followed by
all the input held for it; its start event's cause is `continuation`.
The continuation component names the handoff entry after a handoff and
the unsorted file after a fallback. A rewind to a continuation turn
reruns it in its checkpoint window with its continuation component, and
an edit replaces all its user messages with the edit. A rewind that
removes a context turn removes the window it built, and the next
delivery reconciles every source against the window before it.
