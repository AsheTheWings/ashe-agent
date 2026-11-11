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
`sessionDir`. It holds `research/`, `memory`, and `scratch`, which
[storage](storage.md#session-files) explains.

## History

A session's history is a sequence of events numbered by a counter that
only increases, so no number is ever used twice. Each event is persisted
before any subscriber receives it. `session.subscribe` with `afterSeq`
sends every persisted event after that number in order, then each new
event, with no gap or repeat, so a client that reconnects resumes from the
last number it saw. All subscribers receive the same events in the same
order.

The history is a sequence of turn aggregates. A *UserTurn* is one
admitted, ordered input bundle, whose content identities may include
system, developer, and user messages. The following *AgentTurn* is the
agent text, reasoning, model calls, and tool activity it causes, up to
the next admitted UserTurn or settlement to idle. The store records both
as one turn with one `runId`; a tool-loop iteration starts no turn of its
own.

A turn starts from waiting input: user messages, notification components,
or both. Its `RUN_STARTED` event gives its cause, `continuation` when it
is a continuation turn, else `user` when its starting input holds a user
message, else `notification`, and the ids of those user messages. Its
`membership` is the ordered content identities admitted with it and never
changes. A turn runs until it finishes, fails, is cancelled, or is
interrupted by a server stop, and it keeps running when its client, or
every client, disconnects. Turn settlement is distinct from session idle:
an idle session may still hold queued input, a pending restoration, or a
context workflow checkpoint.

## Input

`session.input` stores the user message as waiting input, with an
`INPUT_WAITING` event naming its id, text, mode, and sender, before it
returns the message's id, so a client can show it as pending. Its optional
selection patch carries requested title, model, and effort changes; its
optional attachments claim retained originals for that input and remain on
the admitted user entry and its request manifest. On an idle
session, the message then starts a turn. While a turn runs, a message
waits in the steering lane by default: it waits for the complete model
response and every tool that response requested to settle, never entering
between tools of that batch. All steering input present at that admission boundary becomes
one new UserTurn, in arrival order; a later arrival waits for the next
boundary. A message sent with mode `queue` waits until execution is idle
and no steering input is waiting, then joins the other eligible queued
messages as one UserTurn. Steering therefore precedes older queued input.

At admission, the batch's requested settings apply in arrival order. An
immutable `session_settings` revision is written for each effective change,
and the AgentTurn references the final revision established at its UserTurn
boundary. Its history entries retain that title and model, including when
the turn later fails. A model or effort change, and a steering, context, or
continuation handoff, affects the next AgentTurn.

`session.resume` requests a continuation on an idle session. It is refused
while a turn or context workflow is active. The continuation joins one
priority-selected steering batch, else one queued batch, else starts a
developer-only turn.

A message's `INPUT_RECEIVED` event follows its `INPUT_WAITING` event when
it enters an admitted UserTurn. A steering message admitted at the current
turn's complete step starts the next UserTurn; it never joins that turn's
AgentTurn. Messages of each mode enter in order of arrival, so a steering
batch enters before an earlier queued batch, which waits for the turn to
end. A turn's input, its events, and its `RUN_STARTED` event commit with
the removal of that input from the waiting input.

The harness delivers developer messages too. A notification component,
such as the one a rewind queues, waits like a steering message: it starts
the next UserTurn at the current turn's complete step, or starts a turn in
an idle session. State components never start a turn: each delivery of user
messages or notification components carries a state component for each
source, such as the user instructions or a catalog, that changed since the
model last saw it. A delivery keeps its notification components and user
messages in arrival order, places a component a rewind or fork caused
directly after that rewind's or fork's component, and places its state
components before its first user message. Each delivered developer
message has a `DEVELOPER_MESSAGE` event; [model context](model-context.md)
explains the components.

During a context workflow, external user messages and unrelated
notifications wait for its continuation turn, which takes eligible held
steering input before held queued input; only memory restored components
join the context turn itself. When a context turn ends without a
continuation turn, the held input starts a turn as queued input does. A
question and permission decision are client actions, not UserTurns;
[model context](model-context.md#questions) and
[permissions](permissions.md) explain their domain behavior.

`session.cancel` ends the running turn with a `RUN_FINISHED` event whose
outcome is `cancelled`. It aborts the running model call and tool call,
and gives each of the turn's tool calls without a result a `canceled`
result saying whether it had started. A turn that ends in any way
withdraws its unanswered permission requests with `PERMISSION_WITHDRAWN`
events in the same transaction as its final event.

Every tool call gets exactly one result before the session's next model
call: its own, or a failed one saying it was canceled, declined,
interrupted, timed out, or failed with its turn, and whether execution
had started. `TOOL_EXECUTION_STARTED` marks a call the server started
running. [Tools](tools.md) owns the elapsed execution budget.

## Fork and rewind

Only a turn whose starting input holds a user message is a rewind point
and a fork point; a developer-only turn is neither. A rewind may target
the active turn. Both restore or initialize research and memory as
[storage](storage.md#session-files) explains and change no other file,
process, or effect of earlier turns. Scratch, workspace files, shell
processes, network effects, and delivered actions are outside their
scope.
When the kept history does not know about a scratch loss or a memory
republish, a rewind queues the scratch lost or memory restored component
again after its own, and a fork queues it after its fork component, which
waits for the fork's next admitted input.

`session.fork` creates an idle session with a new id from a source
session's settled prefix through the given fork point; without a `runId`
it selects the latest settled pair. It copies the turns and events through
that AgentTurn and before the next UserTurn even while the source executes
later work, keeping their event numbers and leaving the source unchanged.
An unsettled point is refused, as is a request with no eligible pair.
The new session gets its own new session directory. Its `SESSION_CREATED`
event gives the source's applied selection and agent settings, which it
starts with. It also keeps the conversation state that no copied turn or a
copied turn owns, preserving inherited authorship while sharing immutable
content, and the source's
[session grants](permissions.md#session-grants). The source's
`SESSION_REWOUND` and `MODEL_CHANGED` events, pending input, active
client actions, and shell processes are not copied. Its first eligible
delivery carries the fork component, which reconciles identity and file
generations without starting a model call by itself.

`session.rewind` removes a rewind point's turn and every later turn with
their events, the conversation state they own, and the `INPUT_WAITING`
events of the messages they took, so no client can read them again. In
the same transaction, it stores the rewind component and the removed
turn's user messages, or the given text instead, as waiting steered input
with new ids, emitting their `INPUT_WAITING` events after its
`SESSION_REWOUND` event, which names the first removed number. A client
drops its events from that number on. A failure leaves the history as it
was; once the rewind commits, its input starts the rerun turn, after a
restart too. A rewound continuation turn's continuation component waits
again before that input, so its rerun is a continuation turn in the same
checkpoint window. A rewind keeps every session grant.

A rewind of an active turn first takes exclusive scheduling control and
stops that turn, so its cancellation path cannot admit the queued input
that preceded the rewind. The rewind transaction removes pending input and
turn ownership that preceded it, reconstructs the selected UserTurn, and
starts no execution until the file restoration is complete. While a history
operation holds that control, `session.input` and `session.resume` return a
conflict without accepting new work.

## Restart

Sessions, their events, and their session grants survive a server
restart. On start, the server first settles the memory draft of each
context turn a stop left running, then
ends each turn a stopped server left running: it withdraws the turn's
unanswered permission requests with `PERMISSION_WITHDRAWN` events, gives
each of its tool calls without a result an `interrupted` result saying
whether it had started, then emits `RUN_INTERRUPTED`. Once every such
turn has ended, input left waiting goes through ordinary lane selection
again, and the session accepts new input. Recovery creates no
continuation and replays no tool call or client action; a session with no
eligible pending input stays idle.
