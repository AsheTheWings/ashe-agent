# Trust model

The agent acts with its owner's reach on the server's machine. This doc
states how far that reach goes and what limits it.

- Shell commands run as the server's own OS user, with that user's full
  rights and without a sandbox. MCP servers over stdio run the same way.
- [Permission rules](permissions.md) are the only limit on what a tool call
  does. A call that no rule matches runs.
- Input that `shell_write_stdin` sends to a running process is not checked
  again; the check of the command that started the process covers it.
- `web_search` sends its queries, and `web_fetch` the URLs it fetches, to
  Exa.
- `context_append` and `context_get_open_items` are never
  permission-checked; they only record and read the session's timeline
  entries. The user's answers to `context_ask_question` are recorded as
  entries in the timelines, so they reach later checkpoint windows and
  `memory/`.
- Rewind and fork restore a session's research and memory files to the
  turn they return to, and change nothing else: other files the removed
  turns wrote, `scratch/`, commands they ran, and every other effect stay
  as they are. A forked session's history may still name its source's
  paths.
- A memory generation is read-only by file mode alone, which processes
  of the server's user can change. The memory check at each turn start
  and step boundary republishes the generation when its symlink, a mode,
  a file's metadata and content, or the set of files differs; a change
  that keeps a file's metadata goes undetected.
- Any valid token grants all of this reach: every session, every tool,
  and every permission answer. That covers access tokens and API tokens,
  and refresh tokens too, since `auth.refresh` exchanges a valid one for a
  new access token; the web client keeps its refresh token in the
  browser's `localStorage`.
