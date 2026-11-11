# Storage

The server keeps its state in one SQLite database,
`database/ashe-agent.db` in the state directory, opened with `bun:sqlite`
in WAL mode with foreign keys enforced; opening fails on a filesystem
where SQLite cannot use WAL. The `database` directory holds only the
database file and SQLite's `ashe-agent.db-wal` and `ashe-agent.db-shm`
beside it, so a backup can leave the live database's directory out and
copy a consistent dump instead.

## Conversation state

A session's canonical history is its ordered `session_entries`: developer,
user, agent, thought, and tool entries, each with an immutable content
reference, authorship, local or inherited ownership, and the title and
model that established it. `window_entries` records which entries each
checkpoint window includes. The content store keeps immutable bytes by
SHA-256 and content references retain them while any entry, model call,
manifest, attachment, snapshot, or baseline needs them. `window_items`,
`developer_components`, and `tool_result_clearings` are read-only views of
that history for the context and timeline paths. They translate content to
the former text shape and clearing positions to their numeric entry
positions, and omit a tool invocation until it has a result.

The session's applied title, model, and effort are immutable rows in
`session_settings`; `sessions.current_settings_revision` names the current
one. A turn references the applied revision established at its UserTurn
boundary, and `turn_inputs` records its ordered input membership and which
input applied a settings revision. A turn also records its cause,
settlement, first event, and context workflow association.
`context_workflows` keeps one workflow's trigger, participating turn, start
position, clearing and validation counts, clearing allowance, and
construction state across turn aggregates. Every row a turn makes names
that turn and references its `turns` row with a cascading foreign key; rows
made at session creation, such as the first window and its seed, name no
turn.

`model_calls` records each request's ordinal, checkpoint window, offered
tool definitions, lifecycle outcome, and provider replay payload.
`request_manifests` freezes the ordered input contribution references
before a request; only calls with a successful outcome are eligible as a
successful boundary. Each manifest records the renderer and digest of its
provider input and each contribution's transformation. Successful
compaction, research, and handoff requests use the same records. `agent_tools`
holds one lifecycle row per owned tool invocation, with its provider call id,
structured arguments, start and settlement times, result, and outcome. Its
model call and parent invocation have session-scoped foreign keys; migrated
legacy rows without a recorded call carry an explicit unavailable marker.
`request_manifest_rendered` retains the immutable rendered provider input and
each contribution's rendered representation.
`context_result_replacements` records a clearing as a replacement over the
retained result.

`uploads` holds draft-owned resumable staging, with fixed one-MiB chunks in
`upload_chunks`, while `attachments` holds finalized originals.
`attachment_references` claims an original for pending or admitted input.
Unclaimed staging expires from its creation time; a claimed original stays
while its input, retained history, request manifest, or fork references it.
Owner clients resolve a retained original through `content.get` by session,
content, and attachment, entry, or manifest reference; a reference from
another session is not found.

A rewind deletes the removed turns' rows, and the foreign keys delete
every row they own with them, so the conversation is again what the kept
turns and creation made: a removed context turn's checkpoint window,
clearings, trims, compaction texts, model calls, and manifests go, so the
kept results are uncleared and each compaction entry has its earlier text
again. Original user attachments come from their retained identities, and
the same transaction claims them for the reconstructed input before old
references go, leaving no staging-expiry or restart gap. Applied settings
revisions remain while the session or a surviving turn references them.
A fork copies the rows that no turn owns and those owned by its settled prefix,
excluding rows created by
the next UserTurn and later work, and preserves inherited authorship while
sharing immutable content. A context workflow's durable state follows its
participating turns without making a later window or auxiliary result part
of an earlier prefix.

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
- `memory-draft/`: during a context turn, a writable copy of the current
  memory generation, which replaces it when validation passes. A context
  turn that ends early settles it, and a server start settles the draft
  of a context turn a stop left running and removes every other draft;
  [model context](model-context.md#context-turns) explains how.

Creating or forking a session records it only after its directory,
first memory generation, and scratch target exist; a failure removes
exactly what that attempt created. At start, before serving, the server
removes each entry of the sessions directory, the memory directory, and
the scratch root that is named like a session id without a session row,
following no symlink and keeping every other entry.

Before each admitted UserTurn starts, including a steering-created turn,
the server snapshots the research files and the
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
memory files of the snapshot of the source's first turn after the selected
pair, or the source's stable current files when no later turn exists, and copies the
source's scratch, keeping symlinks, skipping sockets, FIFOs, and devices,
and refusing a scratch over 2 GiB.

## Migrations

The schema comes only from the migrations in `packages/harness/migrations`.
Each file is named `NNNN_name.sql`, numbered from `0001` with no gap or
repeat, and is embedded in the server through
`packages/harness/src/store/migration-files.ts`, which a conformance test
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

The semantic-history migration translates recoverable native entries,
settings, grants, and retained content into the current tables. Historical
model calls and request boundaries that were never recorded remain absent;
the migration does not invent them. The following tool-ownership migration
rebuilds tool lifecycle rows with explicit unavailable call markers and
session-scoped foreign keys, and replaces the compatibility views with the
declared text, numeric-position, and settled-result shapes.

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
