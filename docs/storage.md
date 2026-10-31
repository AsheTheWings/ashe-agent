# Storage

The server keeps its state in one SQLite database,
`database/ashe-agent.db` in the state directory, opened with `bun:sqlite`
in WAL mode with foreign keys enforced; opening fails on a filesystem
where SQLite cannot use WAL. The `database` directory holds only the
database file and SQLite's `ashe-agent.db-wal` and `ashe-agent.db-shm`
beside it, so a backup can leave the live database's directory out and
copy a consistent dump instead.

## Conversation state

A session's conversation state is rows of its own: its checkpoint
windows, each window's items, the developer component each component item
holds, and its waiting input. The content store keeps text that
components refer to by SHA-256, such as each version of the user
instructions. Every row a turn makes names that turn and references its
`turns` row with a cascading foreign key; rows made at session creation,
such as the first window and its seed, name no turn.

A rewind deletes the removed turns' rows, and the foreign keys delete
every row they own with them, so the conversation is again what the kept
turns and creation made. A fork copies the rows that no turn owns and
those of the turns it copies into the new session.

## Session files

A session's directory, `<state-dir>/sessions/<session-id>/`, holds:

- `research/`: the research files, the regular Markdown files directly
  inside it. The server reads and writes none of them through a symlink.
- `memory`: a symlink to the session's current memory generation,
  `<state-dir>/memory/<session-id>/<n>/`, a directory of mode 0555 whose
  memory files have mode 0444. Publishing a generation writes a new
  directory from stored contents, records it as current, renames a new
  symlink over `memory`, and deletes the session's other generations, so
  a reader of `memory` sees one whole generation. A server start
  completes a publish a stop interrupted. Each memory file's metadata is
  recorded when it is published, so the memory check hashes only a file
  whose metadata differs; a file whose bytes still hash to the recorded
  digest counts as unchanged.
- `scratch`: a symlink to the session's scratch target,
  `<scratch-root>/<session-id>/`, for disposable files. A missing target
  is recreated empty at the next turn start or step boundary, which tells
  the model with a scratch lost component.

Creating or forking a session records it only after its directory,
first memory generation, and scratch target exist; a failure removes
exactly what that attempt created. At start, before serving, the server
removes each entry of the sessions directory, the memory directory, and
the scratch root that is named like a session id without a session row,
following no symlink and keeping every other entry.

Before each turn starts, the server snapshots the research files and the
current memory generation's files: their bytes go to the content store
and the turn's snapshot rows name each file and its digest. A rewind
records a pending restore of the removed turn's snapshot in its
transaction, then writes each research file under a temporary name and
renames it into place, deletes the research files the snapshot lacks,
publishes the snapshot's memory files as the next generation, and drops
the pending restore with the stored contents nothing references any
longer. A restore that fails or that a stop interrupts stays pending: the
session starts no turn and refuses rewinds and forks until a later
request or server start completes it. A fork writes the research and
memory files of the snapshot of the source's first turn after the fork
point, or the source's current files without one, and copies the
source's scratch, keeping symlinks, skipping sockets, FIFOs, and devices,
and refusing a scratch over 2 GiB.

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
