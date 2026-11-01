# Protocol

Clients talk to AsheAgent over one WebSocket path, `/v1/ws`, in JSON-RPC
2.0 messages. `packages/protocol` defines every message once as an Effect
Schema. [`schemas/protocol.schema.json`](../schemas/protocol.schema.json)
is generated from it for clients in other languages, and accepts and
rejects exactly what the Effect decoders do. Each message's fields are
defined there; this page explains how they fit together.

The protocol is at version 1 and may change incompatibly at any revision
before AsheAgent 1.0.

## Messages

A client sends requests, each with an `id` the server's response repeats.
Ids are strings or integers. A method whose params define no fields, such
as `models.list`, may omit `params`; otherwise `params` is an object.
`ClientRequest` in the JSON Schema lists every method with its `params`,
and the `<method>.result` definitions give each method's result. The
server sends responses and `session.event` notifications, together
`ServerMessage`. A response holds either `result` or `error`, and an
error response to a request whose id could not be read has id `null`.

Decoders ignore fields they do not know, so a message may carry fields a
newer peer added.

## Versions and authentication

A connection's first request authenticates it and states the client's
protocol version, a positive integer; this package describes version 1.
The request is `auth.login` with the owner password, `auth.refresh` with a
refresh token, or `auth.authenticate` with an access token or an API
token. A server that does not support the stated version answers with the
`unsupportedVersion` error, whose `data.supportedVersions` lists the
versions it does support. [Authentication](authentication.md) covers the
rules for a connection's first message.

## Methods

A client connects to `/v1/ws`, authenticates with its first request as
the next section explains, and then sends any of these:

- `models.list` gives the configured models, each with its id, display
  name, context limit, whether it takes image input, the reasoning
  efforts it lists, and its configured effort, and the default model.
  `agents.list` gives each agent with its title file's state and the
  default agent, as [agents and skills](agents-and-skills.md) explains.
- `session.list` gives every session's summary, and `session.create`
  starts one, optionally with a model from `models.list`, an agent, and a
  reasoning effort the model lists.
- `session.subscribe` streams a session's events, as
  [session events](#session-events) explains, and `session.unsubscribe`
  stops them.
- `session.input` sends input. Without a mode it starts a turn on an idle
  session or steers the running turn at its next step boundary; with mode
  `queue` it waits for the running turn to end and then starts the next.
  `session.cancel` cancels the running turn.
- `session.setModel` switches the session's selected model and reasoning
  effort, which the next turn uses; without an effort, the selection is
  cleared. The `MODEL_CHANGED` event records it.
- `session.answerQuestion` answers a `QUESTIONS_ASKED` event's question
  set by its `questionSetId`: each answer names a question's `id` and an
  option's `label` as its `selection`, a `note`, both, or neither, which
  skips the question. The first answer settles the set for every client
  with `QUESTIONS_ANSWERED`; a later one, or an answer to a set whose
  call ended, is refused. [Model context](model-context.md#questions)
  explains the limits and what the agent receives.
- `permission.answer` answers a `PERMISSION_REQUESTED` event with `once`,
  `always`, or `reject`, and a message that a rejection returns as the
  call's result. The first answer resolves the request for every client;
  [permissions](permissions.md) explains the rules and grants.
- `session.fork` copies a session through the fork point `runId`, or
  entirely, into a new session. `session.rewind` removes the rewind point
  `runId` and every later turn, then reruns its user messages or the
  given `text`.

[Sessions](sessions.md) explains turns, input, fork, and rewind in full.

## Session events

A session's history is a sequence of events, numbered by `seq` from 1 and
never reusing a number. `session.subscribe` streams the persisted events
after `afterSeq`, then live events. Each `session.event` notification
carries one event under `event`, inside an envelope of `sessionId`, `seq`,
and `timestamp` in milliseconds since the Unix epoch.

Events for text, reasoning, tool calls, and run lifecycle use the
[AG-UI 1.0](https://docs.ag-ui.com) event types and fields: a run is a
turn, and AG-UI's `threadId` is the session id. The protocol's own events
cover what AG-UI does not:

| Event | Meaning |
| --- | --- |
| `SESSION_CREATED` | The session's first event: its `sessionDir`, agent, model, reasoning effort, and fork source. |
| `CHECKPOINT_WINDOW_SEEDED` | A checkpoint window's construction, with its number and each seed component's type, heading, and text; `runId` is null for the first window and names the context turn that built a later one. |
| `INPUT_WAITING` | A user message stored as waiting input, with its id, text, mode, and sender. |
| `INPUT_RECEIVED` | A user message entering the conversation, with its sender and mode. |
| `DEVELOPER_MESSAGE` | A developer message delivered into a run, with each component's type, heading, and text. |
| `SESSION_ERROR` | An error that ends nothing, such as unreadable user instructions, with a code, a message, and the run it arose in. |
| `TIMELINE_ENTRY` | A timeline entry recorded in a run: its number, kind, fields, and for a `done` entry the entries it resolves. |
| `TIMELINE_ENTRY_REPLACED` | A compaction entry's text replaced, keeping its number and place. |
| `CONTEXT_TURN_STARTED` | The rest of a run is a context turn, with its trigger: `threshold` when the reserve ran short, `limit` at the context limit. |
| `TOOL_RESULTS_CLEARED` | A context turn's clearing, its attempt from 1 to 3, and the estimated tokens it freed. |
| `VALIDATION_FAILED` | A context turn's check of `research/` and `memory-draft/` found violations, with its attempt and each violation. |
| `CHECKPOINT_WINDOW_FAILED` | A context turn could not build the next checkpoint window, and the session keeps its current one. |
| `QUESTIONS_ASKED` | A `context_ask_question` call's question set, with its id, the tool call, the questions, and `feedback` on the session's previous set. |
| `QUESTIONS_ANSWERED` | The first answer to a question set, with its sender. |
| `RUN_INTERRUPTED` | A run the server was still running when it stopped. |
| `MODEL_CHANGED` | A new selected model and reasoning effort, null for the model's default, used from the next run. |
| `SESSION_REWOUND` | A rewind removed every event from `firstRemovedSeq` on. |
| `TOOL_EXECUTION_STARTED` | The server started running a tool call. |
| `PROGRAM_CALL_FINISHED` | A tool call made by the code mode program of an `execute` call ended. |
| `PERMISSION_REQUESTED`, `PERMISSION_RESOLVED`, `PERMISSION_WITHDRAWN` | A tool call waiting for an answer, and its end. |

`RUN_STARTED` adds to AG-UI's fields the run's `model`, its `cause`, and
`userMessageIds`, the user messages its starting input holds. The cause
is `continuation` for the run that starts a checkpoint window after a
context turn, `user` for one whose starting input holds a user message,
and `notification` for one a developer message started on its own, such
as a memory restored component.

A user message is waiting from its `INPUT_WAITING` until its
`INPUT_RECEIVED`. A context turn holds the messages that arrive during
it, so they stay waiting until its continuation run receives them.

A client applying `SESSION_REWOUND` drops its events numbered
`firstRemovedSeq` and later before it applies the events after it. The
server also deletes the `INPUT_WAITING` events of the messages the
removed runs received, so a client drops those too, wherever they are
numbered; the rerun's messages wait again under new ids.
[Sessions](sessions.md) explains how inputs, turns, fork, and rewind
produce these events.

## Errors

Error responses use JSON-RPC 2.0's codes for malformed messages, unknown
methods, and invalid params, and codes from -32000 down for the protocol's
own errors. `ErrorCode` in `packages/protocol/src/jsonrpc.ts` names them.
