# Glossary

The terms these docs use, with the meaning they have in ashe-agent.

- **Harness**: the part of ashe-agent that runs the agent loop, the tools,
  the model's context, and permissions.
- **Server**: the `ashe-agent serve` process. It hosts the harness, keeps
  sessions alive between turns and across client connections, and speaks
  the [protocol](protocol.md).
- **Graph engine**: LangGraph, the in-process engine that runs a turn's
  steps and records their checkpoints.
- **Client**: any process that speaks the protocol, such as the
  [web client](web-client.md). A client can disconnect at any time without
  affecting a session.
- **Owner**: the one person a server serves, who signs in with the owner
  password or acts through API tokens.
- **Session**: a durable conversation: its history of events, its session
  directory, which is its starting working directory, its shell
  processes, and its permission grants.
- **Turn**: one run of the agent loop for a session, from the input that
  starts it until the model answers without tool calls, or the turn is
  canceled, fails, or is interrupted by a server stop.
- **User turn**: a turn started by a user input; the only point a rewind or
  fork names.
- **Step boundary**: the point between two steps of a turn, after a model
  call or after the tool calls it asked for.
- **Steer**: input that joins the running turn at its next step boundary.
- **Queued input**: input held until the running turn ends, which then
  starts the next turn.
- **Fork**: copying a session, through one of its user turns or entirely,
  into a new session with its own session directory.
- **Rewind**: removing a user turn and every later turn from a session,
  then running its input, or an edited input, again. It reverts no effect
  of the removed turns.
- **Selected model**: the model a session's next turn runs on.
- **Developer record**: the turns another model ran, sent to the selected
  model as one developer block, as [model context](model-context.md)
  explains.
- **Compaction**: replacing the older part of a session's model context
  with a summary so that the next model call fits the model's context
  window.
- **Agent**: a named set of instructions, model settings, and permission
  rules from an agent file; see [agents and skills](agents-and-skills.md).
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
