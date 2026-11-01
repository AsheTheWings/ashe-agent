# Glossary

The terms these docs use, with the meaning they have in AsheAgent.

- **Harness**: the part of AsheAgent that runs the turn loop, the tools,
  the model's context, and permissions.
- **Server**: the `ashe-agent serve` process. It hosts the harness, keeps
  sessions alive between turns and across client connections, and speaks
  the [protocol](protocol.md).
- **Client**: any process that speaks the protocol, such as the
  [web client](web-client.md). A client can disconnect at any time without
  affecting a session.
- **Owner**: the one person a server serves, who signs in with the owner
  password or acts through API tokens.
- **Session**: a durable conversation: its history of events, its session
  directory, which is its starting working directory, its shell
  processes, and its permission grants.
- **Turn**: one run of the turn loop for a session, from the input that
  starts it until the model answers without tool calls and nothing joins,
  or the turn is canceled, fails, or is interrupted by a server stop.
- **Identity**: the speaker a block stands for: system, developer, user,
  or agent. It is distinct from a message's Responses role and from a
  connection's authenticated sender.
- **User message**: the text of the user identity, in a `<user>` block.
- **User input**: a Responses user-role message, holding any blocks.
- **User turn**: a turn started by user input of developer messages, user
  messages, or both.
- **Rewind point** and **fork point**: a turn whose starting input holds a
  user message; only these can be rewound or forked at.
- **Step boundary**: the point after the results of a model call's tool
  calls and after a reply without tool calls, where waiting steers join
  the turn.
- **Steer**: a user message or notification component that joins the
  running turn at its next step boundary.
- **Queued input**: a user message held until the running turn ends,
  which then starts the next turn.
- **Checkpoint window**: one instance of a session's model context, from
  one checkpoint window construction to the next, the first starting at
  session creation: its harness instructions and its items, the developer
  components, user messages, assistant messages, and tool results every
  model call sends.
- **Checkpoint window size**: the most estimated tokens a model call of a
  checkpoint window may send, per model and agent.
- **Context window**: the model's own capacity, which its provider
  enforces.
- **Harness seed**: the harness instructions and the seed components that
  open a checkpoint window.
- **Working margin**: what a checkpoint window size leaves after the
  harness seed's allowance, the tool definitions allowance, and the
  reserve.
- **Checkpoint window construction**: building a checkpoint window's
  harness seed, at session creation or at the end of a context turn.
- **Context turn**: the rest of a turn after its checkpoint window ran
  short, in which the agent puts its context in order before the next
  checkpoint window.
- **Continuation turn**: the turn that starts a checkpoint window after a
  context turn, with the continuation component and the input held for
  it.
- **Context limit**: a model call's estimated input reaching the
  checkpoint window size, or the provider refusing it as over the context
  window.
- **Clearing**: replacing the oldest tool results of a checkpoint window
  with a placeholder at the context limit.
- **Primary timeline**: a session's numbered entries not trimmed from it;
  **secondary timeline**: a file in `memory/` holding entries trimmed
  from it; **timelines**: both.
- **Open item**: an `open` or `problem` entry no `done` entry resolves.
- **Chat boundary**: a stretch of the conversation from a user message
  until its size reaches 60,000 tokens, which one compaction entry
  summarizes.
- **Compaction entry**, **research entry**, **answer entry**, and
  **handoff entry**: the entries the harness writes, summarizing a chat
  boundary, a research file's change, a user's answer to a question, and a
  checkpoint window that filled up.
- **Research baseline**: the research files a checkpoint window's
  research entries are measured against.
- **Checkpoint**: the session checkpoint component, the last seed
  component of a later checkpoint window, holding the timelines and the
  recent transcript.
- **Recent transcript**: the latest items before a context turn that a
  checkpoint carries verbatim.
- **Session directory**: a session's own directory, its starting working
  directory, holding `research/`, `memory`, `scratch`, and during a
  context turn `memory-draft/`.
- **Memory generation**: one read-only published version of a session's
  memory files, which `memory` points to.
- **Memory draft**: `memory-draft/`, the writable copy of the memory
  generation a context turn edits.
- **Scratch**: a session's disposable files, outside the state directory.
- **Developer component**: one unit of harness content under its own `#`
  heading, such as the user instructions or a catalog.
- **Developer message**: the `<developer>` block of adjoining developer
  components.
- **Seed**, **state**, **notification**, and **transcript** components:
  developer components typed by how they are injected. A seed component is
  rendered when a checkpoint window is built; a state component rides on a
  delivery; a notification component is steered into a turn or starts
  one; a transcript component renders another model's items when a
  checkpoint window is rendered for the turn's model.
- **Reconciliation**: comparing each source's current state, such as the
  user instructions or the dates, with the state the checkpoint window
  knows, yielding one state component for each that differs, with each
  delivery.
- **Delivery order**: notification components and user messages in
  arrival order, a component a rewind or fork caused directly after that
  rewind's or fork's component, and state components before the first
  user message.
- **Fork**: copying a session, through one of its fork points or
  entirely, into a new session with its own id and session directory.
- **Rewind**: removing a rewind point's turn and every later turn from a
  session, then running its user messages, or an edited message, again.
  It reverts no effect of the removed turns.
- **Selected model**: the model a session's next turn runs on.
- **Harness instructions**: the content of the `<system>` block that
  opens the first user input of every model call.
- **User instructions**: the content of the global instructions file, or
  of the body of the title file of the session's agent.
- **Agent**: the configuration a session runs as, keyed by its title:
  its starting model, model setting overrides, and permission rules; see
  [agents and skills](agents-and-skills.md). It is distinct from the agent
  identity, the speaker of the model's own replies.
- **Title**: an agent's key, 1 to 64 characters of `a-z` and `0-9` words
  joined by single dashes, shown as its display title, such as
  `Code Reviewer`.
- **Title file**: `<title>.md` in the titles directory, holding an agent's
  description and user instructions.
- **Provider**: one OpenAI Responses endpoint with its API key file and
  the models it serves; see [configuration](configuration.md).
- **Model id**: `<provider>/<model>`, a provider's id followed by that
  provider's own id of the model.
- **Capabilities**: what a model entry says the model accepts: its input
  types, a temperature, and its reasoning efforts.
- **Settings**: a model's `checkpointWindowSize`, `temperature`, and
  `reasoningEffort`, set by its entry and overridden by an agent.
- **Skill**: an Agent Skills directory whose instructions the model loads
  when it needs them.
- **Tool namespace**: a group of tools, such as `file` or one MCP server's,
  whose tools reach the model as `<namespace>_<tool>`.
- **Shell process**: a process that one `shell_exec_command` call started,
  addressed by its `process_id` while it runs.
- **MCP server**: a Model Context Protocol server the server connects to,
  over stdio or Streamable HTTP, whose tools join the harness.
- **Code mode**: running a program the model writes, which calls tools
  through a confined interpreter; see [code mode](code-mode.md).
