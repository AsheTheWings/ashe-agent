# ashe-agent

ashe-agent is a single-owner agent server in development. It currently
consists of its input layer: the schema declaring every configuration and
protected input, the resolver that merges and validates them, and the
files generated from that schema. Nothing about it is stable yet, and
its configuration may change incompatibly at any revision.

## Repository

The repository is a Bun workspace. `packages/server` holds the server's
input layer.

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
- [Testing](docs/testing.md): the fast gate and the command for each test
  class.
