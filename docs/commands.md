# Commands

`ashe-agent` is one command with these subcommands. Each resolves and
validates its inputs, as [configuration](configuration.md) describes, and
exits with status 2 naming every invalid or missing input before doing
anything else. A usage error exits with status 64 and any other failure
with status 1.

| Command | What it does |
| --- | --- |
| `serve` | Runs the server and prints its WebSocket URL on standard output once it listens. |
| `check` | Validates `serve`'s inputs, reads its provider API key files, and parses its OTLP headers file, then prints the WebSocket URL `serve` would listen on, without opening the database or listening. With listen port 0 the URL carries port 0, since `serve` picks the port only when it listens. |
| `migrate` | Creates the state directory and database when absent and applies pending migrations. |
| `migrate status` | Lists applied and pending migrations without writing; drift fails it. |
| `db dump <path>` | Writes a consistent copy of the live database to `<path>`. |
| `token create <name>` | Creates an API token and prints it once. |
| `token list` | Lists active API tokens with their creation and last use. |
| `token revoke <name>` | Revokes an API token and closes its connections. |
| `--version` | Prints `AsheAgent` and the revision the command was built from. |

`ashe-agent-web` is the built-in backend's separate command. It has
`serve`, `migrate`, `migrate status`, `db dump <path>`, and `--version`
with the same exit and validation rules. `serve` starts its observer and
HTTP/WebSocket listener only after every web migration is current; it
never synchronizes the schema. `migrate status` opens the web database
read-only and writes nothing. See [web client](web-client.md) and
[storage](storage.md#built-in-web-state).

`serve`, `db dump`, and the `token` commands refuse
to run until `migrate` has applied every migration, and `serve` also
refuses a ledger that drifted from the migrations it carries. See
[storage](storage.md).

The owner signs in with GitHub through the [web client](web-client.md);
[authentication](authentication.md) describes logins and API tokens.

The agent's read-only session discovery workflow requires the official
`sqlite3` executable. Bounded PDF conversion requires util-linux
`prlimit`. Startup reports unavailable paths through the affected operation
and never installs either prerequisite. Bundle qualification exercises both
when they are available, as [testing](testing.md#bundle-and-release-gate)
describes.

PDF conversion is an internal child-process entry point launched by the
server under its configured limits. It is not an operator subcommand and
does not expose a general-purpose conversion or execution interface.
