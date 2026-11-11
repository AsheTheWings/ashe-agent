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
- PDF rendering and text extraction run locally in a separate worker under
  data, stack, CPU, wall, input, and output limits. The server passes it only
  the bytes selected for conversion; no PDF content is sent to a conversion
  service, and OCR is not performed. A worker failure fails the current
  projection without an in-process fallback.
- Upload staging and attachment originals stay on this host. A model call
  sends only the representation selected for that model: a sanitized native
  PDF, page images and text, or extractable text.
- Retained tool output and derived attachment representations are readable by
  the server's user and by processes with that user's rights; their modes do
  not protect them from those processes.
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
