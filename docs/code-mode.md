# Code mode

Code mode lets the model script MCP tools: it writes a JavaScript
program, the server runs it in a confined interpreter, and the program
calls tools and combines their results before anything returns to the
model. The interpreter is `packages/codemode`, imported from opencode
v2.2.1 under its MIT licence.

## What code mode holds

The code mode inventory holds the tools of every MCP server whose entry
does not set `codemode: false`. Built-in tools and the tools of servers
that opt out are offered to the model directly and are not callable from
programs. A program calls a tool as `tools.<server>.<tool>(input)`, with
every character outside `A-Z`, `a-z`, `0-9`, `_`, and `-` in either name
replaced by `_`, as in the tool's registered name.

The `execute` tool runs one program, `{ code }`. It is offered while the
inventory holds at least one tool. Programs get no host globals: there is
no `fetch`, filesystem, process, timer, or module access, and the global
`search(...)` function finds tools in the inventory.

## The catalog

The developer message's code mode section carries the catalog: each
server's namespace with its tool count, then one line per listed tool
giving its signature and the first line of its description. The catalog
is rendered within 4,000 tokens, estimated at 4 characters per token
with each line, its newline included, rounded up.
Every namespace is always listed; tools are then added one per namespace
in turn, shortest listing first, while the budget lasts. When some tools
are left out, the catalog says it is partial and tells the model to find
unlisted tools with `search` instead of guessing names. A later change to
the catalog reaches the model as a harness note, as
[model context](model-context.md) describes.

## Calls inside a program

Running a program is decided under the `execute` permission by the
subject `*`. Each tool call the program makes is then decided under that
tool's own permission, as a direct call would be. A denied call, or one
the user rejects with a reason, fails inside the program, which can catch
the error and go on. A plain reject ends the program and the turn, as it
does for a direct call, and its result keeps the images of earlier calls. A call that succeeds returns its text to the
program; its images join the `execute` result after the program's
output, in the order the calls started.

Each finished call emits `PROGRAM_CALL_FINISHED` with the called tool's
registered name and outcome. When a restart interrupts a program, the
`execute` call's interrupted result lists those finished calls in order.

## The language

Programs are JavaScript run by an interpreter, not by the server's
JavaScript engine, and they differ from ordinary JavaScript:

- A program is the body of an async function: top-level `await` and
  `return` work, and a final expression is its result.
- Values cross between the program and its tools as `JSON.stringify`
  would carry them, so functions and `undefined` properties vanish and a
  cyclic value throws.
- Programs get no host globals, as stated above; the code mode component
  test "code mode programs > get no fetch, timer, process, or module
  globals and cause no host effect" in
  `packages/server/test/codemode.component.test.ts` shows them absent.
- Some syntax and built-ins are not supported, among them classes,
  user-defined constructors, getters and setters in object literals,
  BigInt, and typed arrays other than `Uint8Array`.

[`packages/codemode/interpreter-support.md`](../packages/codemode/interpreter-support.md)
is the full matrix of supported features and known gaps, checked against
test262 by `bun run test:test262`.

## Limits

The code mode limits input bounds each program's time, tool calls, and
retained output bytes; each limit is unlimited when absent. Images count
toward the output bytes by their encoded data: they are kept in order
while they fit, and the result says how many were left out. Notices of
truncated output or left-out images, and the headings of warnings and
logs, are added beyond the limit. The time
limit counts only time when none of the program's calls waits for a
permission answer, so a program waiting on an ask does not run out of
time. Canceling the turn interrupts a running program and its pending
calls whether or not it waits.
