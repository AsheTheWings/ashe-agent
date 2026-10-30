# Model context

This page explains what each model call of a turn carries and how the
server keeps a session's context within the model's window.

## The agent loop

A turn runs on the server's own LangGraph `StateGraph`, checkpointed after
every step in the session's thread. Its steps are compaction, the model
call, the tool calls the model made, and steering, which takes inputs
steered into the turn. The turn ends after a model call that made no tool
call when no steered input waits, or after a plain reject. Tool calls of
one model call run one after another, in the order the model made them.

The graph runs in the turn's Effect fiber and receives its `AbortSignal`.
A cancel interrupts the fiber, which aborts the running model call and
tool call, ends the open text, reasoning, and tool call streams, and gives
every tool call of the turn without a result a canceled result saying
whether it had started.

## Model calls

Model calls use the OpenAI Responses API at the configured base URL, with
the configured API key and the turn's model id, through LangChain's
`ChatOpenAI`. Each call asks the provider not to store it, so it carries
its whole input, and requests reasoning with its encrypted content, so
later calls of the same model can send that reasoning back. Every call
sets `instructions` to the fixed line `You're a helpful assistant.`.

The server reads no `OPENAI_*`, `LANGCHAIN_*`, `LANGSMITH_*`,
`LANGGRAPH_*`, or `LC_*` process variable: `serve` removes them before the
agent loop starts, so the libraries cannot take configuration or tracing
settings from them.

## Blocks

The conversation reaches the model in tagged blocks inside user messages:

- `<system>` holds the harness instructions,
  `packages/server/src/agent/harness.md`, which nothing in a session
  changes.
- `<developer>` holds the session's developer message, harness notes,
  summaries, and records of other models' turns.
- `<client>` holds one user input.

The first message of every call opens with the `<system>` block, then the
`<developer>` block of the developer message, then the session's first
input as a `<client>` block when it is in the window. Every later input is
a `<client>` block in its own user message, and each harness note, such as
a fork or a rewind, a `<developer>` block in its own user message. Tool
calls and their results use the Responses API's function call and
function call output items, never blocks.

The server escapes each literal `<system>`, `</system>`, `<developer>`,
`</developer>`, `<client>`, and `</client>` in the text it places in a
block as `&lt;…>`, so only the server opens and closes blocks.

## The developer message

The developer message holds these sections, each under a fixed top-level
heading followed by a one-line introduction, in this order, leaving out
the ones a session has no content for: the instructions recorded at the
session's creation, the skill catalog, the code mode catalog, and the
session's id and starting working directory. Headings inside the
instructions are lowered one level, so they sit below the section's
heading; nothing else in them changes.

The server renders the first message once, when it creates the session,
so its text stays the same for every call of the session. A fork renders
its own first message, with its own session id.

## Other models' turns

Each turn runs every model call with the model selected when it started.
A call sends the turns that model ran as ordinary messages and items. Each
run of consecutive turns other models ran becomes one user message
holding a developer record: a `<developer>` block that holds each input as
a `<client>` block, each reply as an `<agent model="…">` block, each tool
call and result as `<tool_call>` and `<tool_result>` blocks, and each
harness note as a nested `<developer>` block. A record leaves out the
other model's reasoning and shows each image a tool result carried as
`[image: <path>]`. Switching back to a model sends its turns as ordinary
messages again.

## Compaction

Before each model call, the server estimates the call's input tokens: the
last call's reported input tokens plus about one token per four
characters of what was added since. When fewer than 60,000 tokens of the
model's usable window would be left, it compacts first. The usable window
is the model's configured context window, capped at 480,000 tokens.

Compaction keeps the most recent entries, up to 20,000 estimated tokens
and never starting with a tool result, and summarizes everything before
them in one call to the turn's model with at most 8,000 output tokens.
That call uses the prompt in `packages/server/src/agent/summary-prompt.md`
with the previous summary, if any, and a transcript in the developer
record's form, each tool result clipped to 2,000 characters from each
end. The compacted window is the first message, the summary as a
`<developer>` block, and the kept entries; the turn then continues.

A model call that fails as exceeding the context window compacts and
retries once. A failed summary call, a second overflow, or an overflow
whose entries all fit in the kept tail, so compaction cannot shrink the
window, ends the turn with an error event, and the session accepts new
input. Before a call, a window with nothing to summarize is sent as it
is. Each compaction emits a `COMPACTED` event
with the estimated tokens before and after and the summary prompt's
revision, the start of its SHA-256; the session's events stay unchanged.

A rewind or fork continues from the window as it stood at the end of the
last turn it keeps, so a rewind to before a compaction restores the
uncompacted window.
