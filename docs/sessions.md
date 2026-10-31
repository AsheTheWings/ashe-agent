# Sessions

A session is one conversation with its own session directory, model, and
history. Every client of the owner sees every session.

## Session directory

Creating a session takes no working directory: `session.create` refuses
a request naming `cwd`. The server creates the session's directory,
`<state-dir>/sessions/<session-id>/`, readable by the server user alone,
when it creates the session. That directory is the session's starting
working directory: shell commands without a `workdir` run there, and a
relative `workdir`, `file_read` path, or `file_patch` path resolves
against it. `SessionSummary` and the `SESSION_CREATED` event give it as
`sessionDir`.

## History

A session's history is a sequence of events numbered by a counter that
only increases, so no number is ever used twice. Each event is persisted
before any subscriber receives it. `session.subscribe` with `afterSeq`
sends every persisted event after that number in order, then each new
event, with no gap or repeat, so a client that reconnects resumes from the
last number it saw. All subscribers receive the same events in the same
order.

The history is a sequence of turns. A turn starts from waiting input:
user messages, notification components, or both. Its `RUN_STARTED` event
gives its cause, `user` when its starting input holds a user message, else
`notification`, and the ids of those user messages. A turn runs until it
finishes, fails, is cancelled, or is interrupted by a server stop, and it
keeps running when its client, or every client, disconnects.

## Input

`session.input` stores the user message as waiting input, with an
`INPUT_WAITING` event naming its id, text, mode, and sender, before it
returns the message's id, so a client can show it as pending. On an idle
session, the message then starts a turn. While a turn runs, a message
steers it by default: it waits for the turn's next step boundary, never
interrupting a running model call or tool call, and joins the turn there.
A message sent with mode `queue` waits for the turn to end and then starts
the next turn; queued messages start turns in order of arrival. A steered
message that arrives after the turn's last step boundary starts the next
turn instead, and so does input left waiting when a turn could not start,
together with the next input.

A message's `INPUT_RECEIVED` event follows its `INPUT_WAITING` event when
it enters the conversation: when it starts a turn or joins one at a step
boundary. Messages of each mode enter in order of arrival, so a steered
message enters before an earlier queued one, which waits for the turn to
end. A turn's input, its events, and its `RUN_STARTED` event commit with
the removal of that input from the waiting input.

The harness delivers developer messages too. A notification component,
such as the one a rewind queues, waits like a steered message: it joins
the running turn at its next step boundary, or starts a turn in an idle
session. State components never start a turn: each delivery of user
messages or notification components carries a state component for each
source, such as the user instructions or a catalog, that changed since the
model last saw it. A delivery keeps its notification components and user
messages in arrival order, places a component a rewind or fork caused
directly after that rewind's or fork's component, and places its state
components before its first user message. Each delivered developer
message has a `DEVELOPER_MESSAGE` event; [model context](model-context.md)
explains the components.

`session.cancel` ends the running turn with a `RUN_FINISHED` event whose
outcome is `cancelled`. It aborts the running model call and tool call,
and gives each of the turn's tool calls without a result a `canceled`
result saying whether it had started. A turn that ends in any way
withdraws its unanswered permission requests with `PERMISSION_WITHDRAWN`
events in the same transaction as its final event.

Every tool call gets exactly one result before the session's next model
call: its own, or a failed one saying it was canceled, declined,
interrupted, or failed with its turn, and whether it had started.
`TOOL_EXECUTION_STARTED` marks a call the server started running.

## Fork and rewind

Only a turn whose starting input holds a user message is a rewind point
and a fork point; a message steered into a running turn makes none. Both
change only the conversation, never files, processes, or other effects of
earlier turns, and both are refused while a turn runs.

`session.fork` creates a new session with a new id from a source
session's turns through one of its fork points, or all of them, keeping
their events' numbers, and leaves the source unchanged. The new session
gets its own new session directory. Its `SESSION_CREATED` event gives the
source's agent, selected model, and reasoning effort, which it starts
with. It also keeps the agent settings the source recorded, the
conversation state that no turn owns or a copied turn owns, and the
source's [session grants](permissions.md#session-grants); the source's
own `SESSION_REWOUND` and `MODEL_CHANGED` events, and input still
waiting, are not copied. Its first delivery carries the fork component,
which tells the model the source and new session ids. Files in the
source's directory stay there.

`session.rewind` removes a rewind point's turn and every later turn with
their events, the conversation state they own, and the `INPUT_WAITING`
events of the messages they took, so no client can read them again. In
the same transaction, it stores the rewind component and the removed
turn's user messages, or the given text instead, as waiting steered input
with new ids, emitting their `INPUT_WAITING` events after its
`SESSION_REWOUND` event, which names the first removed number. A client
drops its events from that number on. A failure leaves the history as it
was; once the rewind commits, its input starts the rerun turn, after a
restart too. A rewind keeps every session grant.

## Restart

Sessions, their events, and their session grants survive a server
restart. On start, the server
ends each turn a stopped server left running: it withdraws the turn's
unanswered permission requests with `PERMISSION_WITHDRAWN` events, gives
each of its tool calls without a result an `interrupted` result saying
whether it had started, then emits `RUN_INTERRUPTED`. Once every such
turn has ended, input left waiting starts turns in order of arrival, and
the session accepts new input.
