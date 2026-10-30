# Storage

The server keeps its state in one SQLite database, `ashe-agent.db` in the
state directory, opened with `bun:sqlite` in WAL mode with foreign keys
enforced; opening fails on a filesystem where SQLite cannot use WAL.
LangGraph checkpoints live there too, through the server's own checkpoint
saver.

Each session's model context is a LangGraph thread named by the session
id, with a checkpoint after every step of a turn; each checkpoint stores
the whole context. A turn records the thread's latest checkpoint when it
ends. A rewind removes the checkpoints after the last kept turn's, and a
fork copies the source's checkpoints through the last copied turn's into
its own thread.

## Migrations

The schema comes only from the migrations in `packages/server/migrations`.
Each file is named `NNNN_name.sql`, numbered from `0001` with no gap or
repeat, and is embedded in the server through
`packages/server/src/store/migration-files.ts`, which a conformance test
keeps equal to the directory.

The ledger table `schema_migrations` records each applied migration's
position, name, and the SHA-256 of its SQL. Migrating first compares the
ledger with the directory and refuses a recorded checksum or name that
differs, a position that repeats or skips, and a recorded migration the
directory lacks. It then applies each pending migration together with its
ledger row in one transaction, so a failing migration leaves neither, and
repeats the comparison inside that transaction, so a ledger another
process changed meanwhile is refused.
Reading the status opens the database read-only and writes nothing.

An applied migration is never edited, renamed, or deleted; a change to the
schema is a new migration.

## Dumps

A dump writes a consistent copy of the live database with SQLite's
`VACUUM INTO`, which reads one snapshot while the server keeps writing. The
copy goes to a temporary file beside the destination, is flushed to disk,
and is renamed into place, so the destination always holds a complete
copy. A failed dump removes its temporary file and leaves an existing
destination unchanged. Only flushing the directory after the rename can
still fail; its error says the complete copy is in place but the rename
may not survive a crash. The copy is an ordinary SQLite file that opens
without the server.
