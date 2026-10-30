# ashe-agent

ashe-agent is a single-owner agent server in development. It currently
consists of its input layer, which declares, merges, and validates every
configuration and protected input, its client protocol's message
definitions, its SQLite store with migrations, a LangGraph checkpoint
saver, and consistent dumps, and a WebSocket server that authenticates the
owner's logins and API tokens and keeps durable sessions that several
clients share, with steering, queueing, fork, and rewind. Its agent loop
calls a model through the OpenAI Responses API, switches models within a
session, and compacts long sessions. Its built-in tools read files,
documents, and images, and edit files by patch.
Nothing about it is stable yet, and its configuration,
protocol, and storage may change incompatibly at any revision.

## Repository

The repository is a Bun workspace. `packages/server` holds the server's
input layer, store, WebSocket server, agent loop, and the `ashe-agent`
command, and `packages/protocol` the protocol's message schemas.

## Set up

The repository's development, tests, and CI use Bun 1.4.4 exactly, and
its tasks refuse any other version. With that Bun on `PATH`:

```sh
bun install --frozen-lockfile
bun run gate
```

## Use

Run the command from the repository with `bun packages/server/src/main.ts`.
A first start in development:

```sh
export ASHE_AGENT_PROFILE=development
bun packages/server/src/main.ts migrate
bun packages/server/src/main.ts owner set-password
bun packages/server/src/main.ts serve
```

`serve` also needs the model API key file and the model list; see
[configuration](docs/configuration.md).

## Documentation

- [Commands](docs/commands.md): what each `ashe-agent` command does.
- [Configuration](docs/configuration.md): how inputs reach the server, the
  config file, profiles, and protected files.
- [Authentication](docs/authentication.md): the owner password, logins,
  API tokens, and how connections authenticate.
- [Protocol](docs/protocol.md): how clients and the server exchange
  messages and session events.
- [Sessions](docs/sessions.md): history, input during turns, fork,
  rewind, and restarts.
- [Permissions](docs/permissions.md): how permission rules decide tool
  calls, and how clients answer permission requests.
- [Agents and skills](docs/agents-and-skills.md): global instructions,
  agent files, and skills, and where the server reads them.
- [Tools](docs/tools.md): the built-in tools, their permissions, and what
  they read and write.
- [Model context](docs/model-context.md): what each model call carries,
  model switching, and compaction.
- [Storage](docs/storage.md): the database, its migrations, and dumps.
- [Testing](docs/testing.md): the fast gate and the command for each test
  class.
