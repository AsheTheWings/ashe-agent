# Sessions

A session is one conversation with its own working directory, model, and
history. Every client of the owner sees every session.

## History

A session's history is a sequence of events numbered by a counter that
only increases, so no number is ever used twice. Each event is persisted
before any subscriber receives it. `session.subscribe` with `afterSeq`
sends every persisted event after that number in order, then each new
event, with no gap or repeat, so a client that reconnects resumes from the
last number it saw. All subscribers receive the same events in the same
order.

The history is a sequence of turns. A turn starts with one user input and
runs until it finishes, fails, is cancelled, or is interrupted by a
server stop. A turn keeps running when its client, or every client,
disconnects.

## Input

`session.input` on an idle session starts a turn with the input. While a
turn runs, input steers it by default: it waits for the turn's next step
boundary, never interrupting a running model call or tool call, and joins
the turn there. Input sent with mode `queue` waits for the turn to end and
then starts the next turn; queued inputs start turns in order of arrival.
Steered input that arrives after the turn's last step boundary starts the
next turn instead.

Each input's `INPUT_RECEIVED` event, naming its sender, is emitted when it
enters the conversation: when it starts a turn or joins one at a step
boundary. Inputs of each mode enter in order of arrival, so a steered input
enters before an earlier queued one, which waits for the turn to end.
`session.input` returns the input's id at once, so a client can show it as
pending until then. An input's event, its turn, and the turn's
`RUN_STARTED` event commit together.

`session.cancel` ends the running turn with a `RUN_FINISHED` event whose
outcome is `cancelled`. It aborts the running model call and tool call,
and gives each of the turn's tool calls without a result a `canceled`
result saying whether it had started. A turn that ends in any way
withdraws its unanswered permission requests with `PERMISSION_WITHDRAWN`
events in the same transaction as its final event.

Every tool call gets exactly one result before the session's next model
call: its own, or a failed one saying it was canceled, declined,
interrupted, or failed. `TOOL_EXECUTION_STARTED` marks a call the server
started running.

## Fork and rewind

Both change only the conversation, never files, processes, or other
effects of earlier turns, and both are refused while a turn runs. The
session's next model call tells the model so in a harness note.

`session.fork` creates a new session from a source session's turns
through one of its user turns, or all of them, keeping their events'
numbers, and leaves the source unchanged. The new session starts with the
source's working directory, agent, selected model, and recorded
instructions, which its `SESSION_CREATED` event gives; the source's own
`SESSION_REWOUND` and `MODEL_CHANGED` events are not copied. Its model
context is the source's as it stood after the last copied turn, and its
first model call is told the source and new session ids.

`session.rewind` removes a user turn and every later turn with their
events, so no client can read them again, then starts a turn with the
removed turn's input, or with the given text instead, before any other
input. Its `SESSION_REWOUND` event names the first removed number, and a
client drops its events from that number on. The removal, the rewound
event, and the new turn's start commit in one transaction, so a failure
leaves the history as it was. The new turn's model context is the one at
the end of the last turn kept; [model context](model-context.md)
explains both.

## Restart

Sessions and their events survive a server restart. On start, the server
ends each turn a stopped server left running: it withdraws the turn's
unanswered permission requests with `PERMISSION_WITHDRAWN` events, gives
each of its tool calls without a result an `interrupted` result saying
whether it had started, then emits `RUN_INTERRUPTED`, and the session
accepts new input.
