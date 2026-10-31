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
sends the whole window, rendered for the turn's model.

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
fails as exceeding the context window ends the turn with an error event
of code `context_overflow`; the session keeps its checkpoint window and
accepts new input.

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
