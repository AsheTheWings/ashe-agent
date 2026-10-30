# Permissions

Permission rules decide whether a tool call runs, is refused, or waits for
an answer from a client. The agent is trusted at its owner's level: tools
run as the server's own OS user, without a sandbox, and the rules are the
owner's way to require a look before chosen calls.

## Rules

The `permission` input, in the config file or as JSON in
`ASHE_AGENT_PERMISSION`, follows opencode's shape. It is either one action
for every call, or an object mapping permission names to an action or to
an object mapping patterns to actions. An action is `allow`, `ask`, or
`deny`.

```json
{
  "permission": {
    "edit": "ask",
    "shell": { "*": "ask", "git status*": "allow", "rm *": "deny" }
  }
}
```

A permission name or pattern matches by wildcards: `*` matches any
characters, `?` matches one character, and every other character matches
itself. `~` or `$HOME` at the start of a pattern, alone or before a `/`,
expands to the server user's home directory. A name mapped straight to an
action is that action for the pattern `*`.

A call is checked against the global rules, then the rules of the
session's agent, then the session's grants, all in the order they are
written, and the last rule matching both its permission name and its
subject decides. A call that no rule matches is allowed, so nothing asks
or is refused until the rules say so.

## Subjects

Each tool names the permission it asks under and the subjects of a call,
such as paths, commands, or URLs, along with the patterns an `always`
answer grants. A call with several subjects is decided per subject, then
as a whole: any denied subject refuses the whole call, else any asked
subject raises one request naming the asked subjects, else the call runs.

Paths are decided as absolute paths against the session's working
directory, resolved one component at a time as the operating system
resolves them, so a relative or linked path is decided by the file it
reaches, and a `..` after a symlink leaves the symlink's target. A part of
the path that does not exist yet is kept as written, and a dangling
symlink is replaced by the path it points to.

## Denials and requests

A denied call never runs; the model gets a result saying it was denied by
configuration, and the turn goes on. A call starts, with
`TOOL_EXECUTION_STARTED`, only once the rules or an answer allow it.

A call that asks emits `PERMISSION_REQUESTED` to every subscriber and
waits inside the running turn. Any authenticated client answers with
`permission.answer`; the first answer resolves the request with
`PERMISSION_RESOLVED`, and a later answer gets the `alreadyResolved`
error.

- `once` runs the call.
- `always` runs the call and adds a session grant: an allow rule for each
  pattern the request names, kept with the session. Every other pending
  request of the session that the grants now allow is approved with it.
- `reject` without a message declines the call. The model's next call
  sees the declined result, and the turn ends without another model call;
  the turn's later tool calls get canceled results.
- `reject` with a message fails the call with the message as its result,
  and the turn goes on.

A `reject` rejects every other pending request of the session too, with
the same message if any.

A pending request lives only in the running turn. A turn that ends, by
cancel or otherwise, and a server restart withdraw its unanswered requests
with `PERMISSION_WITHDRAWN`, as [sessions](sessions.md) describes.

## Session grants

A session's grants survive a server restart and a rewind, and a fork
starts with its source's grants. Grants are stored in the
`session_grants` table.
