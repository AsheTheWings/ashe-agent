# Testing

Tests run on `bun test` under the pinned Bun. Every test command runs the
tests with only `PATH`, a temporary `HOME`, `TMPDIR`, `LANG`, and `TZ` in
their environment, so no developer or production input reaches them.

## Fast gate

`bun run gate` typechecks the repository and runs the unit and conformance
tests. CI runs it on every push, on every pull request that is not a
draft, and on manual dispatch.

## Test classes

A test's class is the suffix of its file name.

| Class | File suffix | Command | Boundary |
| --- | --- | --- | --- |
| unit | `.unit.test.ts` | `bun run test:unit` | pure functions: no filesystem, sockets, processes, process configuration, or waits |
| conformance | `.conformance.test.ts` | `bun run test:conformance` | read-only checks that generated files, pins, and versions match their sources |

`bun run typecheck` runs the TypeScript checker alone.

Each test command prints the seed of its randomized tests, which also
appears in their names. Setting `ASHE_AGENT_TEST_SEED` to it for a test
command reruns them with the same values; the command gives the seed to
the tests as a build-time constant, not through their environment.
