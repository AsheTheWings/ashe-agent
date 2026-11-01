# Testing

Tests run on `bun test` under the pinned Bun. Every test command runs the
tests with only `PATH`, a temporary `HOME`, `TMPDIR`, `LANG`, and `TZ` in
their environment, so no developer or production input reaches them;
`bun run test:qualification` adds only the path of the bundle it
qualifies.

## Fast gate

`bun run gate` typechecks the repository and runs the unit, component,
and conformance tests. CI runs it first; see [CI](#ci).

## Test classes

A test's class is the suffix of its file name.

| Class | File suffix | Command | Boundary |
| --- | --- | --- | --- |
| unit | `.unit.test.ts` | `bun run test:unit` | pure functions: no filesystem, sockets, processes, process configuration, or waits |
| component | `.component.test.ts` | `bun run test:component` | the session hub and turn loop in the test's process, with a fake model port and fake tools, on a SQLite file in the test's own temporary directory; code mode programs in the interpreter, in the test's process; the web client's session client over a scripted fake server behind its socket port |
| integration | `.integration.test.ts` | `bun run test:integration` | real SQLite files, `ashe-agent` and bash processes, WebSocket connections, and fake upstream APIs on loopback ports that the test creates, with files in its own temporary directory |
| conformance | `.conformance.test.ts` | `bun run test:conformance` | read-only checks that generated files, pins, and versions match their sources |
| qualification | `.qualification.test.ts` | `bun run test:qualification [<bundle>]` | the binary and web build of a built bundle, extracted into the test's own directory; the binary runs as the server against a run-owned state directory and a fake Responses API on a loopback port |

CI runs the integration tests after the fast gate. The GitHub sign-in
suite uses a run-owned fake GitHub to exercise the owner, rejection,
expiration, upstream failures, and callback telemetry without real
credentials. Development web integration checks use real Vite on dynamic
loopback ports and synthetic configuration.

`bun run test:test262` fetches tc39/test262 at the revision
`packages/codemode/test/test262/manifest.json` pins, into a directory of
its own run, verifies that commit, and runs code mode's test262
integration suite over the files the manifest selects, skipping those
`packages/codemode/test/test262/skipped.txt` lists; the other
integration commands leave that suite out. It needs network access, so it
stays out of the fast gate; CI runs it after the integration tests.

`bun run typecheck` runs the TypeScript checker alone, over the workspace
and then over the web client's browser sources with their own config.

Each test command prints the seed of its randomized tests, which also
appears in their names. Setting `ASHE_AGENT_TEST_SEED` to it for a test
command reruns them with the same values; the command gives the seed to
the tests as a build-time constant, not through their environment.

## Bundle and release gate

`bun run bundle` builds, from a worktree without changes, the server as
one `bun build --compile` executable for linux-x64 and the web client's
production build (see [web client](web-client.md)), both stamped with the
commit, and packages them as `bin/ashe-agent` and `web/` into
`dist/ashe-agent-linux-x64.tar`. `bun run test:qualification` qualifies
that file, or the bundle it is given: it checks that `web/` holds
`index.html` and a `revision.txt` equal to the revision the binary's
`--version` prints, then
migrates, creates an API token, authenticates over WebSocket, and runs a turn with
a shell command and a `file_read` of a docx.

`bun run release-gate` is the release gate: the fast gate, then the
bundle built and qualified, then the web image built with
`bun run web-image` and the gateway image built with
`bun run gateway-image`, each qualified. It needs Podman and `ORAS`; see
[web client](web-client.md#container-image) and [gateway](gateway.md).

`bun run test:web-image <layout> <revision>` qualifies the
[web image](web-client.md#container-image) in an OCI layout as the build
of a commit: it checks the manifest's annotations, then runs the image
read-only in a Podman store of its own run and checks that it serves
that commit's client with its cache headers and writes no console
output. It needs Podman.

`bun run test:gateway-image <layout> <revision>` qualifies the
[gateway image](gateway.md) the same way: it checks the annotations and
the oauth2-proxy version, then runs the image read-only with the
documented arguments and synthetic credentials, listening on a loopback
port of its own run, against a fake GitHub of its run on loopback that
grants only the scopes a sign-in asks for; three URL arguments point the
image at it. It
checks that the image answers `/ping`, refuses `/oauth2/auth` without a
session, asks for the documented scope and callback, gives the allowed
login a session `/oauth2/auth` accepts, refuses another login, and prints
nothing after its startup line. It needs Podman.

## CI

CI runs on GitHub-hosted runners. Every non-draft pull request, every
push, and every manual dispatch runs the fast gate, the integration
tests, test262, the bundle build, and qualification of that bundle.
Pull request runs receive no secrets and no OIDC token, and no workflow
uses `pull_request_target`; the repository requires approval before the
workflows of any outside contributor's pull request run.

On a push or a manual dispatch on a branch, the job that qualified the
bundle then publishes it to the host's artifact registry, the host the
`ARTIFACT_REGISTRY` repository variable names: one `oras push`, with the
job's OIDC token, of the bundle as the single layer of
`ashe-agent/<area>:<commit>-<run id>-<run attempt>`, where the area is
`default` on `main` and `branches` elsewhere. Only that job may request
an OIDC token. It checks that the pushed layer is the qualified bundle
and logs `SHA-256: <hex>` for the manifest digest. The `oras` it runs is
a pinned release whose archive and binary SHA-256 it checks first.

The `web-image` and `gateway-image` workflows run the same way on the
same events, each as its own run: the fast gate, the web build for the
web image, the image built and annotated into an OCI layout, and
qualification of that layout. On a push or a manual
dispatch the job that qualified it pushes the same manifest, checked
against the qualified digest, to
`ashe-agent/<area>:<commit>-<run id>-<run attempt>` and logs
`SHA-256: <hex>` for it.
