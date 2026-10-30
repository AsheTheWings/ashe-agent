# Protocol

Clients talk to ashe-agent over one WebSocket path, `/v1/ws`, in JSON-RPC
2.0 messages. `packages/protocol` defines every message once as an Effect
Schema. [`schemas/protocol.schema.json`](../schemas/protocol.schema.json)
is generated from it for clients in other languages, and accepts and
rejects exactly what the Effect decoders do. Each message's fields are
defined there; this page explains how they fit together.

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
| `SESSION_CREATED` | The session's first event: its `sessionDir`, agent, model, and fork source. |
| `INPUT_RECEIVED` | An input entering the conversation, with its sender and mode. |
| `RUN_INTERRUPTED` | A run the server was still running when it stopped. |
| `MODEL_CHANGED` | A new selected model, used from the next run. |
| `SESSION_REWOUND` | A rewind removed every event from `firstRemovedSeq` on. |
| `TOOL_EXECUTION_STARTED` | The server started running a tool call. |
| `PROGRAM_CALL_FINISHED` | A tool call made by the code mode program of an `execute` call ended. |
| `COMPACTED` | The model's context was compacted. |
| `PERMISSION_REQUESTED`, `PERMISSION_RESOLVED`, `PERMISSION_WITHDRAWN` | A tool call waiting for an answer, and its end. |

A client applying `SESSION_REWOUND` drops its events numbered
`firstRemovedSeq` and later before it applies the events after it.
[Sessions](sessions.md) explains how inputs, turns, fork, and rewind
produce these events.

## Errors

Error responses use JSON-RPC 2.0's codes for malformed messages, unknown
methods, and invalid params, and codes from -32000 down for the protocol's
own errors. `ErrorCode` in `packages/protocol/src/jsonrpc.ts` names them.
