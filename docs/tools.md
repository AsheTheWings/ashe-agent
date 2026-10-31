# Tools

The agent's built-in tools are grouped in namespaces. Models receive each
as a plain function tool named `<namespace>_<tool>`, since not every
provider accepts namespaced or dotted tool names. A built-in tool's
schema admits only the arguments it names; a call with any other
argument, such as a `shell` argument to `shell_exec_command`, fails
without running.

| Tool | Permission | Subjects |
| --- | --- | --- |
| `file_read` | `read` | each file read, resolved |
| `file_patch` | `edit` | each path the patch writes, reads to update, or removes, resolved |
| `shell_exec_command` | `shell` | the command text, `cmd` |
| `shell_write_stdin` | none | covered by the check of the command that started the process |
| `web_search` | `web` | the query |
| `web_fetch` | `web` | each URL |
| `skill` | `skill` | the skill's name; [agents and skills](agents-and-skills.md) describes it |
| `execute` | `execute` | `*`; [code mode](code-mode.md) describes the calls a program makes |
| `<server>_<tool>` | its registered name | `*` |

[Permissions](permissions.md) explains how subjects are resolved and
decided. A tool resolves its paths once, when the call is checked, and
reads, writes, and removes exactly those paths. When a path resolves
differently by the time the call runs, for example because a symlink
changed while the call waited for an answer, `file_read` does not read
that file and `file_patch` changes nothing. A change between that last
check and the read or write itself is not detected.

A path a patch deletes, or moves a file away from, is decided as the
directory entry it names, so deleting a symlink removes the link without
reading its target. A move is also decided for the file its content is
read from and for its destination.

## `file_patch`

`file_patch` takes one `patch` string in Codex's `apply_patch` format:
`*** Begin Patch`, then `*** Add File:`, `*** Delete File:`, and
`*** Update File:` hunks, an update optionally followed by
`*** Move to:`, with `@@` context lines and `*** End of File`, then
`*** End Patch`. Relative paths resolve against the session directory.

The whole patch is checked under the `edit` permission before any file
changes, then its hunks are applied in order. Add File replaces an
existing file, and a move replaces an existing destination. A hunk that
fails stops the patch, and the result names the hunks applied before it.
An update's context matches exactly, else ignoring trailing whitespace,
else ignoring surrounding whitespace, else after normalizing Unicode
punctuation and spaces. Unchanged lines keep their line endings, and
inserted lines take the file's first line ending.

The parser and context matching are ported from opencode's patch module,
and the vendored scenarios of Codex's apply-patch crate, under
`packages/server/test/fixtures/codex-apply-patch/`, check that it behaves
as Codex does.

## `file_read`

`file_read` takes a `path`, either one path or a list of paths and glob
patterns, with an optional `offset`, `column`, and `limit`. Relative paths resolve
against the session directory. Nothing records what a
session read.

Text comes back numbered as `cat -n` numbers it: at most 2,000 lines,
128 KB, and 2,000 characters per line. A negative offset counts from the
end, `-1` being the last line. When a read stops at a ceiling, at an empty
file, or past the end, its result says so and names the offset to
continue from. A line cut at 2,000 characters continues from the offset
and `column`, the line's character to start from, that the result names.
A leading byte order mark is removed and CRLF line endings
become LF.

A list of paths and globs reads each file under a `==> path <==` header,
reports each file's failure inline, and stops at 100 KB of text in total,
naming the files it did not read. One glob reads at most 1,000 files.

`file_read` refuses paths under `/dev` and `/proc/<pid>/fd`, character and
block devices, FIFOs, and sockets before reading them, and binary files
and files over 32 MB.

### Documents

A file of at most 32 MB that anydoc detects as a document, or a `.csv`
file, is converted to Markdown in the server's own process and read
through the same windows as text. Conversion never uses anydoc's hosted
OCR, so no document leaves the host. A failed conversion names anydoc's
error code; a PDF with scanned or image-only pages reports `needsOcr` and
the pages that need OCR.

### Images

A PNG, JPEG, GIF, or WebP file of at most 20 MB is returned as an image
when the turn's model is declared to take images, and as a result saying
the model cannot view images otherwise. Text renderings of the
conversation, such as transcripts of another model's work, show the
image as `[image: <path>]`.

## `shell_exec_command` and `shell_write_stdin`

The shell tools follow Codex's `exec_command` and `write_stdin`, so a
model trained on Codex uses them as it knows them. Codex's `session_id` is
named `process_id`, and the arguments choosing a shell, an approval, a
sandbox, or an environment are left out.

`shell_exec_command` runs `cmd` in a new process of the server user's
login shell, as `<shell> -lc <cmd>`, or `-c` when `login` is false. The
shell is the one the user database gives the server's user, through
`getent passwd`, or `/bin/sh` when it gives none; `SHELL` is not read. It
runs on a pseudo-terminal when `tty` is true and on pipes otherwise, in
`workdir` resolved against the session directory, else in the session
directory. The script the `ASHE_AGENT_SHELL_ENV_FILE` input names, when
set, is sourced in each command's own shell, after its login startup.
When the file is missing or unreadable, the command does not run and the
result says why; when sourcing it returns a nonzero status, for example
on a syntax error or because its last command failed, the command does
not run and exits with code 126 after a line saying so. The login shell
must accept POSIX `.`, `||`, and `{ …; }` syntax, as bash, zsh, and sh do.
A command starts with the server's environment, without the server's own
input variables.

A command returns when it exits, with its exit code, or after
`yield_time_ms`, clamped to 250 to 30,000 ms, with the output so far and a
`process_id`. The process keeps running, and `shell_write_stdin` writes
`chars` to it and returns the output since the last result. After a write
it waits 250 ms by default and at most 30,000 ms; with empty `chars` it
polls for 5,000 to 300,000 ms. Writing `\u0003` interrupts the process.
No command has a timeout of its own.

A result reads:

```text
Wall time: 1.0021 seconds
Process running with process_id 48213
Output:
…
```

An exited process gives `Process exited with code <n>` instead. A result
holds at most `max_output_tokens` estimated tokens, at four bytes each,
else the `ASHE_AGENT_SHELL_MAX_OUTPUT_TOKENS` default: its head and tail
around a `…<n> tokens truncated…` marker, after a warning and an
`Original token count` line. Output no result has returned yet is kept up
to 1 MiB per process the same way, with a `... <n> bytes omitted ...`
marker.

Processes belong to their session. A command runs in its own process
group, so interrupting or ending it reaches what it started. Starting a
process when the session holds `ASHE_AGENT_SHELL_MAX_PROCESSES` ends the
least recently used one, an exited one first, sparing the eight most
recently used, or all but one under a smaller limit. A cancel ends the
waiting call, whose result gives the `process_id`, and leaves the process
running. A rewind leaves processes running, a fork starts with none, and
stopping the server ends them all, along with what exited commands left
running in their process groups, whenever it was started. Each command's
group holds a holder process, a `sleep` that ignores terminal and
interrupt signals, so the group id stays the command's until the server
ends it; the kernel never gives a live group's id to another process. The
holder is ended once its command has exited and left nothing else in the
group. A group whose holder was killed by someone else is never
signaled. A server killed without the chance to stop, for example by
SIGKILL, leaves them running, as it does a process that moved to a
process group of its own. A write to a `process_id` that is gone says so.

The `shell` permission is decided on the command text, so a rule such as
`"git status*": "allow"` matches by how the command is written, not what
it runs. Input written to a running process is not checked: an allowed
command that reads its input, such as a shell or an interpreter, runs
whatever is written to it.

## `web_search` and `web_fetch`

The web tools are offered exactly when an Exa API key is delivered
through `ASHE_AGENT_EXA_API_KEY_FILE`. Both reach the web only through
Exa's API, so the server never connects to a URL the model names.

`web_search` takes a `query` and an optional `numResults` of 1 to 100,
10 by default, and returns each result's title, URL, published date,
author, and highlights. A `category:company`, `category:publication`,
`category:news`, `category:personal site`, or `category:people` term in
the query is sent as Exa's category instead.

`web_fetch` takes 1 to 100 absolute `http` or `https` URLs and an
optional `maxCharacters` per page, 3,000 by default, and returns each
page's text under its title and URL, then a line for each URL Exa failed
to fetch. A call naming anything else fails before it reaches Exa.

An Exa request, its response body included, times out after 120 seconds.
A failed one gives the model the HTTP status and Exa's error tag, or
`timeout` or `unavailable` when no response arrived whole, never the key,
the query, or the URLs.

## MCP tools

Each server under the `mcpServers` input is reached through the MCP
TypeScript SDK, `@modelcontextprotocol/client`: a `stdio` entry runs its
`command` with `args` as a child process of the server, as the server's
user, with the server's environment, minus its own input variables, and
the variables of its `envFile`; an `http` entry speaks Streamable HTTP to
its `url`, sending the headers of its `headersFile`. Both files are
protected files read when the server connects: an env file holds one
`NAME=value` per line and a headers file one `Name: value` per line,
blank lines and `#` comments aside. The server starts no OAuth flow.
The client negotiates MCP revision 2026-07-28 and falls back to the
2025-11-25 handshake for a server that does not support it; for a stdio
server, negotiation runs on a short-lived second copy of its process.

Servers connect in the background when the server starts. Once a server
has listed its tools, each is registered as `<server>_<tool>`, with every
character outside `A-Z`, `a-z`, `0-9`, `_`, and `-` replaced by `_`. When
two tools, of one server or of two, register under the same name,
neither is registered. A server takes only its own tools out of later
model calls when it fails to connect, when its connection closes, or when
a request to it fails and it then does not answer a fresh request for
its tool list within 5 seconds; an answer, even an error response, keeps
its tools. An HTTP server that goes away is noticed at its next request.
Servers do not reconnect. Stopping the server closes every connection,
those still connecting included, and ends stdio server processes. A
server whose entry sets `codemode: false` offers its tools directly to
the model; the tools of every other server are kept for
[code mode](code-mode.md).

An MCP tool call is decided under its registered name as the permission
name, by the subject `*`, so `"docs_search": "ask"` asks before every
call of that tool. A result's text parts come back as text, its images
as images, and other parts as JSON, as is its structured content when it
has no other parts; a result the server marks as an error is a failed
result.
