# Web client

`packages/web` is the built-in browser application. It contains `client/`
for browser code, `backend/` for the Bun backend, and `shared/` for the
web-state wire format. The client talks to the harness directly for
conversation and assigned actions and to the backend for shared
organization. The backend serves the built client from one immutable
asset root.

## Run, build, and package

```sh
bun run dev:web
```

serves the browser client through Vite on `127.0.0.1`. The configured
development endpoint is the harness WebSocket address. The harness owns
the direct conversation socket; the web backend is a separate process.

`bun run build:web` builds from a clean commit and writes to
`packages/web/dist`: the Vite client at the root, the compiled backend at
`bin/ashe-agent-web`, ordered web migrations under `migrations/`, and
`revision.txt` at the root. `bun run bundle` packages that directory under
`web/` beside the harness binary and notices. The browser build cannot
import backend sources or server-only inputs.

The web image runs `/app/bin/ashe-agent-web serve` as UID 65532 with
`/app` read-only and durable state mounted at the configured state
directory. It listens on port 8080 in the reference image and contains no
harness, organization state, or protected credential.

## Backend inputs and state

The web backend is a `webServe` entry point; migrations and dumps use
`webMigrate` and `webDb`. Their inputs come from the same machine-readable
schema and layers as the harness. The state directory holds `web.sqlite`;
the assets and migration directories name the built files explicitly. The
observer credential is a protected file. [Configuration](configuration.md)
owns the layers and [storage](storage.md) owns the database contract.

The backend binds its SQLite file to the first online-validated harness
identity. A different `harnessId` fails closed rather than rebinding or
rewriting state. [Authentication](authentication.md) owns credential
validation, expiry, and renewal.

## Three views

Chat is the first-open view for a session with no saved choice. It shows
user messages in bubbles, grouping messages admitted by one turn, and
assistant output inline. Session stacks typed semantic blocks in canonical
order, including system and developer content, thoughts, tools, and
inherited source provenance. Checkpoint window shows the latest successful
model-input boundary with its contributions, transformations, offered tool
definitions, estimate coverage, and provider usage kept separate.

The header view selector names all three views. `Ctrl+I` cycles them even
when the composer has focus; the header also offers `Alt+I` as an
alternative and a type-to-compose switch. Each session
remembers its last view and each view its scroll position in browser
storage. A preview or attention reveal switches to Session and scrolls its
matching block; ordinary incoming content does not change a retained reading
position.

## Composer and recovery

One fixed composer serves every view. It keeps text, attachments, title,
model, reasoning effort, and delivery mode while views change. Send is
always Send; a separate toggle selects Steer or Queue for the next
submission. Stop appears beside Send while a turn runs and targets the
observed turn identity. Continue appears only when owner observation says
resume is eligible.

Requests for title, model, or effort stay local until Send or a confirmed
rewind. An omitted field inherits the applied selection; an explicit null
model and null effort remain distinct. The applied selection and the
running turn's active selection are shown separately.

Send detaches an immutable snapshot and its submission identity before the
network call. The next draft is committed in the same browser storage
write. Unknown acceptance remains visible and is reconciled through the
harness receipt under the same identity; it is never replayed as a new
submission. A definitely rejected submission can be restored without
overwriting newer active text. Offline Send is disabled, and the client
never builds a durable offline submission queue.

Drafts are partitioned by verified `harnessId`, principal, session, and a
fresh page-load writer identity. Another tab's saved record is an explicit
recovery candidate, never a shared writer slot. Unsupported saved formats
remain in storage and can be exported; no record is silently deleted.
Blocked storage leaves the current in-memory draft editable with a
persistent Not saved locally warning.

Every view shows the shared read-only pending strip. Submitted user
entries are labelled with their mode and expand to their preview. Pending
developer work shows only an attributed count in Chat; full developer
content stays in Session.

## History and questions

Rewind and fork controls appear only in Chat and use the harness-issued
history scope. Rewind previews the target and later history and warns that
it reruns immediately without rolling back external effects. Its text may
be edited; original attachments remain attached and immutable. A stale
scope keeps the edit and does not retarget another boundary. A fork opens
an idle Chat view and copies neither the source draft nor synthetic input.

Questions and permission requests stay inline in Chat. Only the browser
whose connection owns the assigned action can answer. A steering message
resolves that browser's question as replied-by-message after input
acceptance; Queue leaves it open. Plain message text never approves a
permission request.

Session details exposes title-scoped grants: it defaults to the current
title, lists grants for the selected stored title, and clears all grants
for that title after confirmation. It neither edits permission rules nor
revokes an individual grant.

## Attention and inbox

The sidebar separates Working from Inbox using authoritative harness
activity, eligible pending input, continuation, and assignment-validated
human attention. A needs-human hint never forces a view switch by itself;
its indicator opens Chat and reveals the request. An interaction assigned
to another browser says so and cannot be claimed or completed here.

Organization supports pin, read/unread, snooze, filing/reopening, and
conditional undo. Drag to the filing area or use the row menu; organization
changes do not cancel input, answer a request, or alter execution. Explicit
mark-unread advances a read generation so delayed visibility samples cannot
clear it. Manual filing requires fresh quiescence. Inactivity filing
defaults to three days and protects pinned, opted-out, working, attention,
and currently snoozed sessions.

Shared state uses a separate authenticated WebSocket with semantic
commands, durable operation receipts, and ordered revisions. A revision gap
reconciles from a snapshot. While shared state is unavailable, cached
organization is labelled stale, new shared mutations are disabled, and an
already-open direct harness connection and local drafts continue.

## Content and diagnostics

The client renders typed native content and never evaluates tool-provided
HTML, SVG, Markdown HTML, or code as application markup. Links are plain
text unless a native renderer validates their destination. External images
start as a destination/Load placeholder; only an explicit Load makes a
credential-free, referrer-free HTTP(S) image request, and refusal shows an
error or link.

Browser diagnostics go to the backend's bounded, origin-checked,
authenticated intake. The backend exports only catalogued, bounded records
through its OpenTelemetry pipeline; no message, draft, attachment, token,
or tool payload is accepted. [Telemetry](telemetry.md) owns signal names
and privacy rules.

## Signing in

The sign-in page offers **Continue with GitHub** for the configured
harness. The tab keeps its verifier and endpoint in `sessionStorage`,
removes the return fragment before connecting, and exchanges the code once.
The access token stays in memory; the refresh token stays in this browser
under an endpoint-scoped key. Cross-tab refresh holds a bounded Web Lock.
When Web Locks are unavailable or cannot be acquired, no unlocked refresh
is attempted; recoverable drafts remain and the client asks for explicit
sign-in in a secure context. Revocation is shown as lost authorization,
not as ordinary expiry, and never switches principal automatically.
