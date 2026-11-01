# AsheAgent

AsheAgent is a single-owner agent server: one process that runs an
agent for its owner and keeps its sessions alive for any number of
clients, such as the web client this repository includes. Sessions are
durable and shared by every client, with steering, queueing, fork, and
rewind. The agent calls models through the OpenAI Responses API, switches
models within a session, and keeps each session's model context in
checkpoint windows. It works through
built-in tools for files, documents, images, shell commands, and the web,
and through MCP servers, called directly or from code mode programs,
under the owner's permission rules.

AsheAgent is in development. Nothing about it is stable yet, and its
configuration, protocol, and storage may change incompatibly at any
revision.

## Repository

The repository is a Bun workspace of four packages. `packages/server`
holds the server's input layer, store, WebSocket server, turn loop, and
the `ashe-agent` command; `packages/protocol` the protocol's message
schemas; `packages/codemode` the interpreter that runs code mode
programs; and `packages/web` the web client.

## Set up

The repository's development, tests, and CI use Bun 1.4.4 exactly, and
its tasks refuse any other version. With that Bun on `PATH`:

```sh
bun install --frozen-lockfile
bun run gate
```

## Build

`bun run bundle` builds, from a commit with no uncommitted changes,
`dist/ashe-agent-linux-x64.tar`: the server and its commands as one
executable, `bin/ashe-agent`, and the web client's static files under
`web/`. `bun run release-gate` also tests and qualifies it; see
[testing](docs/testing.md). CI builds the same bundle on every push and
publishes it to the host's artifact registry.
It also builds, qualifies, and publishes the
[web client image](docs/web-client.md#container-image).

## Use

Run the command from the repository with `bun packages/server/src/main.ts`,
or as `bin/ashe-agent` from a bundle. A first start in development:

```sh
export ASHE_AGENT_PROFILE=development
bun packages/server/src/main.ts migrate
bun packages/server/src/main.ts serve
```

Before serving, register a GitHub OAuth app with callback
`<server origin>/v1/auth/github/callback`. Use a separate app for development
and production. Write its client secret into an owner-only file, preserving
its bytes, and configure the app and the owner's numeric GitHub user ID:

```json
{
  "githubClientId": "<OAuth app client ID>",
  "githubClientSecretFile": "/absolute/path/to/github-client-secret",
  "githubCallbackUrl": "https://server.example/v1/auth/github/callback",
  "githubOwnerId": 123456,
  "origins": ["https://client.example"]
}
```

For development register the development server's HTTP callback, list the
development client's origin in `origins`, and set `devWebAllowedHosts` when
accessing Vite by a host name. `bun run dev:web` selects development itself
and uses the same config-file loader; it refuses an occupied port.

`serve` also needs the providers, with each provider's API key file, and
the default model; see [configuration](docs/configuration.md). Open the
[web client](docs/web-client.md) and choose **Continue with GitHub**.
[Authentication](docs/authentication.md) describes the flow and limits.

## Documentation

- [Glossary](docs/glossary.md): the terms these docs use.
- [Commands](docs/commands.md): what each `ashe-agent` command does.
- [Configuration](docs/configuration.md): how inputs reach the server, the
  config file, profiles, and protected files.
- [Authentication](docs/authentication.md): GitHub sign-in, logins,
  API tokens, and how connections authenticate.
- [Protocol](docs/protocol.md): how clients and the server exchange
  messages and session events.
- [Sessions](docs/sessions.md): history, input during turns, fork,
  rewind, and restarts.
- [Permissions](docs/permissions.md): how permission rules decide tool
  calls, and how clients answer permission requests.
- [Agents and skills](docs/agents-and-skills.md): agents, title files,
  user instructions, and skills, and where the server reads them.
- [Tools](docs/tools.md): the built-in tools, their permissions, and what
  they read and write.
- [Code mode](docs/code-mode.md): the `execute` tool, its catalog, and the
  permissions and limits of programs.
- [Model context](docs/model-context.md): what each model call carries,
  developer components, and model switching.
- [Web client](docs/web-client.md): running and building the web client,
  signing in, and what it keeps in the browser.
- [Telemetry](docs/telemetry.md): the traces, metrics, and logs the server
  emits, and where it exports them.
- [Trust model](docs/trust-model.md): what the agent can reach and what
  limits it.
- [Storage](docs/storage.md): the database, its migrations, and dumps.
- [Testing](docs/testing.md): the fast gate and the command for each test
  class.
