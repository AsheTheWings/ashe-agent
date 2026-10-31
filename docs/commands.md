# Commands

`ashe-agent` is one command with these subcommands. Each resolves and
validates its inputs, as [configuration](configuration.md) describes, and
exits with status 2 naming every invalid or missing input before doing
anything else. A usage error exits with status 64 and any other failure
with status 1.

| Command | What it does |
| --- | --- |
| `serve` | Runs the server and prints its WebSocket URL on standard output once it listens. |
| `migrate` | Creates the state directory and database when absent and applies pending migrations. |
| `migrate status` | Lists applied and pending migrations without writing; drift fails it. |
| `db dump <path>` | Writes a consistent copy of the live database to `<path>`. |
| `owner set-password` | Sets the owner password and signs every login out. |
| `token create <name>` | Creates an API token and prints it once. |
| `token list` | Lists active API tokens with their creation and last use. |
| `token revoke <name>` | Revokes an API token and closes its connections. |
| `--version` | Prints `AsheAgent` and the revision the command was built from. |

`serve`, `db dump`, `owner set-password`, and the `token` commands refuse
to run until `migrate` has applied every migration, and `serve` also
refuses a ledger that drifted from the migrations it carries. See
[storage](storage.md).

`owner set-password` reads the password from the terminal with echo off
and asks for it twice. When standard input is not a terminal it reads the
password from the first line of its input instead.
