# ashe-agent

ashe-agent is a single-owner agent server in development. It currently
consists of its input layer, which declares, merges, and validates every
configuration and protected input, its client protocol's message
definitions, and its SQLite store with migrations, a LangGraph checkpoint
saver, and consistent dumps. Nothing about it is stable yet, and its
configuration, protocol, and storage may change incompatibly at any
revision.

## Repository

The repository is a Bun workspace. `packages/server` holds the server's
input layer and store, and `packages/protocol` the protocol's message
schemas.

## Set up

The repository's development, tests, and CI use Bun 1.4.4 exactly, and
its tasks refuse any other version. With that Bun on `PATH`:

```sh
bun install --frozen-lockfile
bun run gate
```

## Documentation

- [Configuration](docs/configuration.md): how inputs reach the server, the
  config file, profiles, and protected files.
- [Protocol](docs/protocol.md): how clients and the server exchange
  messages and session events.
- [Storage](docs/storage.md): the database, its migrations, and dumps.
- [Testing](docs/testing.md): the fast gate and the command for each test
  class.
