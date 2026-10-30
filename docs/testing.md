# Testing

Tests run on `bun test` under the pinned Bun. Every test command runs the
tests with only `PATH`, a temporary `HOME`, `TMPDIR`, `LANG`, and `TZ` in
their environment, so no developer or production input reaches them.

## Fast gate

`bun run gate` typechecks the repository and runs the unit, component,
and conformance tests. CI runs it on every push, on every pull request
that is not a draft, and on manual dispatch.

## Test classes

A test's class is the suffix of its file name.

| Class | File suffix | Command | Boundary |
| --- | --- | --- | --- |
| unit | `.unit.test.ts` | `bun run test:unit` | pure functions: no filesystem, sockets, processes, process configuration, or waits |
| component | `.component.test.ts` | `bun run test:component` | the session hub and agent loop in the test's process, with a fake model port and fake tools, on a SQLite file in the test's own temporary directory; code mode programs in the interpreter, in the test's process; the web client's session client over a scripted fake server behind its socket port |
| integration | `.integration.test.ts`, `.integration.vitest.ts` | `bun run test:integration` | real SQLite files, `ashe-agent` and bash processes, WebSocket connections, and fake upstream APIs on loopback ports that the test creates, with files in its own temporary directory |
| conformance | `.conformance.test.ts` | `bun run test:conformance` | read-only checks that generated files, pins, and versions match their sources |

The `.integration.vitest.ts` files run LangGraph's checkpoint saver
validation suite, which is written for Vitest; `bun run test:integration`
runs them under Vitest on Bun after the `bun test` integration tests. CI
runs the integration tests after the fast gate.

`bun run test:test262` fetches tc39/test262 at the revision
`packages/codemode/test/test262/manifest.json` pins, into a directory of
its own run, verifies that commit, and runs code mode's test262
integration suite over the files the manifest selects, skipping those
`packages/codemode/test/test262/skipped.txt` lists; the other
integration commands leave that suite out. It needs network access, so it
stays out of the fast gate; CI runs it after the integration tests.

`bun run typecheck` runs the TypeScript checker alone, over the workspace
and then over the web client's browser sources with their own config.
CI runs `bun run build:web` last; see [web client](web-client.md).

Each test command prints the seed of its randomized tests, which also
appears in their names. Setting `ASHE_AGENT_TEST_SEED` to it for a test
command reruns them with the same values; the command gives the seed to
the tests as a build-time constant, not through their environment.
