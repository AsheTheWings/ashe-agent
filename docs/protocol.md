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
server sends responses, replayable `session.event` notifications, and
directed `action.execute` and `action.cancel` notifications, together
`ServerMessage`. A response holds either `result` or `error`, and an
error response to a request whose id could not be read has id `null`.

The generated schema and protocol decoder close request envelopes and method
params that define fields. Unknown fields there are invalid. A method whose
params define no fields accepts any object, including one with fields.

## Versions and authentication

A connection's first request authenticates it and states the client's
protocol version, a positive integer; this package describes version 1.
The request is `auth.exchange` with a one-time sign-in code and verifier, `auth.refresh` with a
refresh token, or `auth.authenticate` with an access token or an API
token. A server that does not support the stated version answers with the
`unsupportedVersion` error, whose `data.supportedVersions` lists the
versions it does support. [Authentication](authentication.md) covers the
rules for a connection's first message.

`GET /v1/auth/identity` returns the authenticated principal, the
credential's actual `credentialExpiresAt` (explicitly null for a
non-expiring API token), and the harness database's durable opaque
`harnessId`. The web backend validates current credentials through this
endpoint before shared reads and mutations; it never trusts a URL, a
session id, or a previously authenticated socket as installation identity.

## HTTP sign-in endpoints

The same listener answers `GET /v1/auth/github/start` with the client's
`origin` and S256 `challenge`, and `GET /v1/auth/github/callback` with
GitHub's `state` and `code` or `error`. They redirect through GitHub and
return a one-time code in the client's URL fragment. The client removes
the fragment before opening `/v1/ws`, then sends `auth.exchange` with
`code`, `verifier`, and `protocolVersion`. Its result is the same token
pair as `auth.refresh`. [Authentication](authentication.md) owns the flow's
validation, time limits, and failures. Every other path receives 404.

## Methods

A client connects to `/v1/ws`, authenticates with its first request as
the next section explains, and then sends any of these:

- `models.list` gives the configured models, each with its id, display
  name, context limit, declared text, image, and native PDF input
  capabilities, the reasoning efforts it lists, and its configured effort,
  and the default model. `agents.list` gives each agent with its title
  file's state and the default agent, as
  [agents and skills](agents-and-skills.md) explains.
- `session.list` gives every session's summary, and `session.create`
  starts one from an optional selection. An omitted model applies the
  title and configured defaults; an explicit `modelId: null` keeps the
  session durably unconfigured. An explicit `reasoningEffort: null`
  requests the model's default effort.
- `session.subscribe` streams a session's events, as
  [session events](#session-events) explains, and `session.unsubscribe`
  stops them.
- `session.input` sends input: without a mode it is steering delivery, and
  with mode `queue` it waits for idle. A caller names the submission with
  `submissionId`; retrying the same identity and payload returns the
  accepted input instead of accepting another, while changing the payload
  is refused. The result carries that receipt. `session.input.receipt`
  resolves an accepted submission's input id and pending, admitted, or
  removed disposition, or reports it not observed.
  [Session input](sessions.md#input) owns admission and lane priority.
  `session.cancel` names the observed `expectedTurnId`; a matching live turn
  is cancelled, while a settled or replaced target reports no-longer-current
  without touching newer execution.
- `session.observe` returns a revision- and cursor-bound snapshot of ordered
  typed pending input, its attachment references and requested selection,
  execution/history eligibility, and validated action-attention facts.
  Developer pending work is typed, but its full content stays in Session.
- `session.semantics.page` returns bounded pages of `turns`, typed `entries`,
  or successful `boundaries`; `revision` and `cursor` must agree, and a stale
  pair is an explicit conflict. `session.semantics.body` and
  `session.semantics.boundary` read one omitted body or boundary.
  `session.modelCalls.usage` returns stored nullable provider counts for at
  most 100 calls.
- `session.history.inspect` returns a pending-aware mutation scope and target.
  `session.rewind` and `session.fork` require its token and a stable
  `operationId`; `session.history.result` resolves that operation, reports it
  unresolved, or reports it not observed.
- `session.resume` starts a continuation on an idle session. It is refused
  while execution or a context workflow is active.
- Selection changes for an existing session travel with `session.input`
  or `session.rewind`; there is no picker-only mutation RPC. A change
  applies at the next UserTurn boundary.
- `actions.list` gives each registered action's name, description, and
  argument and result JSON schemas. `client.setActions` replaces the
  authenticated connection's advertised support with a list of declared
  names; disconnecting discards it.
- `action.complete` settles the live action `actionId` in `sessionId` with
  its declared `result`. Only the assigned, authenticated connection may
  complete it. Stale, duplicate, cross-session, and unassigned completions
  fail without settling it; an invalid result settles it as failed.
- `session.history.inspect` returns the boundary target and a
  harness-issued confirmation scope covering the retained-history
  revision, pending input and current eligibility. `session.fork` copies
  a settled prefix through the fork point `runId`, or the latest settled
  point, and `session.rewind` removes the rewind point `runId` and every
  later turn, then reruns its user messages or the given `text`; both
  require that scope and a caller-owned `operationId`, and refuse a stale
  confirmation. `session.history.result` resolves an operation's durable
  result independently of the transport, reporting an unresolved
  acknowledgement explicitly.
- `session.semantics` returns the session's immutable turns, canonical
  semantic entries, and every successful request boundary. A boundary
  carries its ordered contribution representations and transformations,
  offered tool definitions, rendered identities, attribution, and
  measurement, so an owner client can build its own model-input view
  without database access.
- `session.semantics.page` reads turns, typed entries or successful
  boundaries in bounded cursor pages under one history revision. A stale
  revision, a cursor without its revision, or a cursor of another
  collection fails explicitly. An entry whose retained body exceeds the
  inline bound carries a body reference; boundary summaries always carry
  theirs. `session.semantics.body` and `session.semantics.boundary` read
  the full immutable body. The page result also names the latest
  successful boundary.
- `session.modelCalls.usage` returns stored nullable provider input,
  output and total token counts by `modelCallId`, separately from the
  manifest measurement. Missing counts stay null and are never estimated.
- `session.observe` returns a coherent cursor-bound owner snapshot: the
  ordered pending user and developer input with requested selection patches
  and attachment references, active execution, continuation, rewind and
  fork eligibility, context/restore state, selection, latest successful
  boundary and validated live attention hints. `OBSERVATION_CHANGED` names
  its canonical revision; any session event is an invalidation, and the
  snapshot itself creates no model input or agent wakeup.
- `session.grants.list` returns persisted always-approval rules for a
  session across title scopes, and `session.grants.clear` removes one
  title's rules.

`GET /v1/auth/identity` accepts an access or API credential in an
`Authorization: Bearer` header. It returns
`{ principal, credentialExpiresAt, harnessId }`; an access token reports its
actual expiry, an API token reports null, and `harnessId` is the durable
opaque identity of the retained harness database. Responses use `Cache-Control:
no-store`, accept no token in the URL, and enforce the configured browser
origins.

`GET /v1/content/<sessionId>/<contentId>/<referenceId>` returns one
retained original after the same bearer validation. A missing identity
returns 404 and an unavailable representation returns 409. Successful
originals always use `Content-Disposition: attachment`,
`X-Content-Type-Options: nosniff`, and
`Content-Security-Policy: default-src 'none'; sandbox`, including unknown
and active-looking MIME types. Browser access follows the configured
origin policy and is never cached.

[Sessions](sessions.md) explains turns, input, fork, and rewind in full.

## Built-in web-state protocol

The built-in web backend has a second WebSocket path, `/v1/web-state`,
separate from the harness execution socket. Its version 1 messages are a
closed shared format in `packages/web/src/shared/web-state.ts`:

- the first message is `web.authenticate` with an access credential and
  protocol version; credential-bearing URLs are not accepted;
- `web.command` carries an `organization.set`, `read.set`, `file.manual`,
  or `undo` command with a caller-owned `operationId`;
- `web.snapshot` returns a consistent revision and every organization row;
  `web.update` carries a revision and changed rows; `web.receipt` reports
  `confirmed`, `rejected`, or `uncertain` for one operation;
- `web.operation` reconciles a lost acknowledgement without reapplying it.

`organization.set` patches independent fields; same-field changes follow
server acceptance order, and conditional undo refuses when a later change
replaced the value. `read.set` marks unread with a generation increment and
accepts mark-read only under the current generation. `file.manual` requires
fresh reconciled quiescence. The backend validates the presented access
credential online for every command and sends a replacement access token
through another `web.authenticate` on the same socket only for the same
principal and bound harness.

A revision gap makes the client request a snapshot. Unknown operations
stay explicit; mutations remain disabled until their receipt is
reconciled. A different `harnessId` at the same or reconfigured endpoint
refuses access without rewriting the store's binding.

## Uploads

An authenticated owner stages an attachment with `upload.create`,
`upload.status`, `upload.append`, and `upload.finalize`. Creation records
a draft id, filename, media type, and declared size. Appends carry standard
base64 chunks at explicit offsets; repeating an already stored offset
returns the same progress, while gaps and conflicting chunks fail.
Finalization verifies the declared size and SHA-256 digest.

The upload id remains stable across disconnects. Unclaimed staging belongs
to its draft and expires after its configured lifetime or owner quota.
Passing a finalized retained-attachment reference to `session.input`,
`session.message`, or rewind claims the original for that input's durable
ownership before staging expiry can remove it.

A large tool observation can also retain a producer capture beside the
session. `content.capture` reads one bounded chunk by session, entry and
content identity; the entry's typed `captures` metadata distinguishes the
retained capture from the model preview and any capture loss. Raw paths,
foreign entries and removed entries are not accepted.

## Client actions

Question and permission interactions are client actions. The server
declares their schemas; a client advertises the names its connection
handles. For each new action, the server selects only an authenticated
connection currently subscribed to the session and supporting the name,
choosing the connection whose server-recorded subscription is newest. It
assigns one executor before sending that connection `action.execute` with
the action id, name, session id, and arguments. Execution is never
broadcast or replayed.

`ACTION_ASSIGNED` and `ACTION_SETTLED` are ordinary session observations.
Their settlement outcomes are `completed`, `canceled`, `timedOut`,
`disconnected`, or `failed`. `action.cancel` is directed only to the
assigned connection when its invocation ends. Unsubscribe and capability
withdrawal do not invalidate an existing assignment; disconnect does, and
the server does not reassign it. If no eligible executor exists, the tool
call gets an unavailable failure immediately.

The assigned connection reports its live action's human-interaction need
with `action.reportInteraction` and `needsHumanInput`. The broker derives
the session and AgentTurn from the assignment, accepts only that
connection's report, and publishes `ACTION_ATTENTION` to owner observers.
Withdrawal, terminal settlement and disconnect clear the hint. The report
creates no UserTurn, developer notification, model input, reassignment or
completion, and observing another connection's hint grants no authority.

[Model context](model-context.md#questions) owns question arguments and
results; [permissions](permissions.md) owns permission decisions.

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
| `SELECTION_CHANGED` | A new immutable applied selection revision, with its title, nullable model and effort, and revision id. |
| `CHECKPOINT_WINDOW_SEEDED` | A checkpoint window's construction, with its number and each seed component's type, heading, and text; `runId` is null for the first window and names the context turn that built a later one. |
| `INPUT_WAITING` | A message stored as waiting input, with its id, text, mode, and sender: the user or the session whose agent submitted it. |
| `INPUT_RECEIVED` | A user message entering the conversation, with its sender and mode; a session sender records the source session identity and effective title and model. |
| `OBSERVATION_CHANGED` | The canonical pending/history/eligibility revision changed; reread `session.observe`. |
| `ACTION_ATTENTION` | The assigned executor reported or withdrew a live action's human-interaction need, with its action, name and AgentTurn. |
| `DEVELOPER_MESSAGE` | A developer message delivered into a run, with each component's type, heading, and text. |
| `SESSION_ERROR` | An error that ends nothing, such as unreadable user instructions, with a code, a message, and the run it arose in. |
| `TIMELINE_ENTRY` | A timeline entry recorded in a run: its number, kind, fields, and for a `done` entry the entries it resolves. |
| `TIMELINE_ENTRY_REPLACED` | A compaction entry's text replaced, keeping its number and place. |
| `CONTEXT_TURN_STARTED` | The run is a context turn, with its trigger: `threshold` when the reserve ran short, `limit` at the context limit. |
| `TOOL_RESULTS_CLEARED` | A context turn's clearing, its attempt from 1 to 3, and the estimated tokens it freed. |
| `VALIDATION_FAILED` | A context turn's check of `research/` and `memory-draft/` found violations, with its attempt and each violation. |
| `CHECKPOINT_WINDOW_FAILED` | A context turn could not build the next checkpoint window, and the session keeps its current one. |
| `ACTION_ASSIGNED` | A declared client action assigned to one executor, with its action id and name. |
| `ACTION_SETTLED` | That action's one terminal outcome. |
| `QUESTIONS_ASKED` | A `context_ask_question` call's question set, with its id, the tool call, the questions, and `feedback` on the session's previous set. |
| `QUESTIONS_ANSWERED` | The first answer to a question set, with its sender. |
| `RUN_INTERRUPTED` | A run the server was still running when it stopped. |
| `MODEL_CALL_STARTED` | A model-call attempt whose streamed content remains provisional. |
| `MODEL_CALL_COMMITTED` | Whole-response success made the attempt's content and successful input boundary durable. |
| `MODEL_CALL_DISCARDED` | A failed, cancelled, or interrupted attempt whose provisional output clients must discard. |
| `SESSION_REWOUND` | A rewind removed every event from `firstRemovedSeq` on. |
| `TOOL_EXECUTION_STARTED` | The server started running a tool call. |
| `PROGRAM_CALL_FINISHED` | A tool call made by the code mode program of an `execute` call ended. |
| `PERMISSION_REQUESTED`, `PERMISSION_RESOLVED`, `PERMISSION_WITHDRAWN` | A tool call waiting for an answer, and its end. |

`RUN_STARTED` adds to AG-UI's fields the run's immutable `selection`,
`settingsRevision`, `cause`, `membership`, and `userMessageIds`.
`membership` is the ordered content identities admitted with the UserTurn,
and `userMessageIds` holds the user messages its starting input carries.
The cause is `continuation` for the run that starts a checkpoint window
after a context turn, `user` for one whose starting input holds a user
message, and `notification` for one a developer message started on its own,
such as a memory restored component.

A user message is waiting from its `INPUT_WAITING` until its
`INPUT_RECEIVED`. A context workflow holds the messages that arrive during
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
