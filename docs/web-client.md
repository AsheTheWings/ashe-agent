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
development endpoint is the harness WebSocket address; when the optional
development web backend URL is set, Vite proxies `/v1/web-state` and
`/v1/web/*` to that backend. The harness owns the direct conversation
socket; the web backend is a separate process.

`bun run build:web-client` builds only the browser client assets into
`packages/web/dist` without compiling the backend binary or requiring a
clean commit, so a source-mode web backend can serve them directly.

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

The base URL `/` renders the centered starter composer without creating a
session yet; sending the first message creates the session on the harness and
moves the browser URL to `/sessions/<sessionId>`. Each existing session lives
at `/sessions/<sessionId>`, supporting direct navigation, page reloads, and
browser Back/Forward history (with the backend serving the revalidated SPA
shell for `/` and valid `/sessions/<sessionId>` paths while returning `404`
for unknown paths).

Chat is the first-open view for a session with no saved choice. When a session
has no messages yet, Chat centers a tall starter composer card with the attach,
agent, model/effort, and send controls inside its bottom toolbar. Once messages
exist, Chat shows user messages in bubbles, grouping messages admitted by one
turn, and assistant output inline with safe GitHub Flavored Markdown rendering,
keeping thoughts, tools, and developer blocks out of the conversation stream.
Chat messages reveal friendly relative timestamps (`Just now`, `5 mins ago`,
`2 hours ago`, `Yesterday`) on hover/focus with exact date/time tooltips.
Session displays full-width, horizontally padded, always-expanded canonical
semantic blocks (`SYSTEM-MESSAGE`, `DEVELOPER-MESSAGE`, `USER-MESSAGE`,
`AGENT-MESSAGE` with the `AA` monogram, `AGENT-THOUGHT`, `AGENT-TOOL`) separated
by horizontal dividers—omitting empty text-less agent carrier entries, grouping
each block's header metadata (including human-readable full date/time and
compact estimated token count with exact tooltips) inline on the left, showing
agent/model identity on agent blocks and on peer-agent `USER-MESSAGE` entries
(linked to the sender session), rendering `AGENT-TOOL` input and result in
equal-height scrollable panes with formatted syntax-colored JSON (expanding
slightly when a payload nearly fits to avoid tiny scrollbars) and semantic
outcome badges, and automatically hydrating large retained bodies as they enter
the viewport. Checkpoint window displays the selected `ModelCallContext`
request-input snapshot with the same padded layout, grouped inline headers
(without per-block timestamps), a single collapsible `TOOL-DEFINITIONS` block
first (collapsed by default), formatted payloads, and automatic hydration.

Switching from Chat to Session anchors Session's scroll position instantly to
the focused user message in Chat without moving Chat's saved scroll position on
return. Selection-safe `Shift+click` on an agent message in Chat or an agent
message, thought, or tool block in Session opens the Checkpoint window snapshot
that generated it.

Every open session uses a `44px` primary header bar on desktop (`>= 48rem`)
hosting the sidebar toggle (when floating or on mobile), the session title, a
centered inset `ViewPanel` owned by the active view, the view selector dropdown
(`Chat`, `Session`, `Checkpoint window`), and a reserved right-hand slot for
the Secondary Window toggle button so adjacent controls never shift. On narrow
mobile viewports (`< 48rem`), `ViewPanel` drops to a `36px` strip beneath the
primary bar. Whenever actionable alerts, errors, or waiting-input notices exist
across sessions (including connection/app errors, resumable turns, waiting
inputs, execution failures, recoverable/unsupported drafts, and composer
status), `SessionNotifications` renders as a conditional `36px` secondary bar
directly below the primary bar (and inside a `44px` primary-styled bar beside
the sidebar toggle on the home screen), showing the latest entry when collapsed
and expanding to a five-entry scrollable list on click. App errors appear in
`SessionNotifications` and never overlay the page.

`ViewPanel` adapts to the active view:

- **Chat:** renders `ActivityPreview`, showing the latest thought summary and
  latest tool call with status even when idle; clicking a preview switches to
  Session and scrolls its matching block.
- **Session:** summarizes high-value session insights—total, user, and agent
  message counts, tool call count and most-used tool, and compact estimated
  token total (`754`, `4.7K`, `1.2M` with exact tooltips); clicking toggles the
  **Session insights** Secondary Window.
- **Checkpoint window:** summarizes the selected snapshot's input token total,
  coverage, a stacked horizontal distribution bar grouped into **Harness**
  (System message, Tool definitions, Developer messages, Tool results),
  **Agent output**, and **User messages**, and the snapshot label
  `Window <N> · <time>` (plus a `Latest` reset control when viewing a historical
  snapshot); clicking toggles the **Checkpoint window** Secondary Window showing
  **Context breakdown** and the timestamped snapshot switcher.

`Ctrl+I` cycles views even when the composer has focus (`Alt+I` and
type-to-compose are configurable in Settings), and `Ctrl+.` toggles the
Secondary Window when the active view provides secondary content. Each session
remembers its last view and each view its scroll position in browser storage;
ordinary incoming content does not change a retained reading position.

The desktop workspace splits into a resizable sidebar (`264px` default,
clamped `220px`–`420px`, persisted in browser storage, toggling between docked
and hover-floating modes), a **Primary Window**, and an optional right-hand
**Secondary Window** (`36%` default, clamped `24%`–`60%`, persisted in browser
storage, drag-resized with a vertical handle). Mobile uses slide-over drawers
for both the sidebar and the Secondary Window. Non-empty recoverable drafts
from other tabs appear as entries in `SessionNotifications`.

## Settings and themes

The sidebar footer opens the Settings dialog, which organizes workspace
configuration into tabs:

- **Appearance:** Light, Dark, or System mode, the warm stock palette,
  six built-in palettes (including **Claude**), custom themes stored in
  browser storage, light/dark half-mixing, JSON import/export, and the
  live custom theme editor. Using a theme paints it immediately and
  remembers the choice in browser storage. New custom themes start from
  canvas and accent seeds that generate a full palette with every color
  role editable, and preview live while restoring the stored theme on
  cancel. Theme choices live only in the browser: blocked storage keeps
  the stock palette for the page, a malformed stored library reads as
  empty, and a missing selected theme falls back to stock.
- **Shortcuts & Input:** View-cycle modifier (`Ctrl+I` or `Alt+I`) and
  the type-to-compose switch.
- **Session & Permissions:** Active session metadata (copyable session
  ID, applied agent and model, workspace path, fork provenance) and
  title-scoped permission grants, defaulting to the current agent and
  clearing all grants for the selected agent after confirmation.

## Composer and recovery

One sticky composer overlays the bottom of every view over a soft top fade,
with no banners or alerts above it. It keeps text, attachments (rendered as
square thumbnail and document cards in a horizontally scrollable strip),
agent profile, model, reasoning effort, and delivery mode while views
change. Send is always Send; while a turn runs, Stop occupies the right-hand action
slot targeting the observed turn identity when the draft is empty, Send
replaces it once a submission is ready, and a Queue toggle selects Queue or
Steer for the next submission. When owner observation says resume is eligible, a
Continue entry appears in `SessionNotifications`.

Requests for agent, model, or effort stay local until Send or a
confirmed rewind. An omitted field inherits the applied selection; an
explicit null model and null effort remain distinct. When draft choices
differ from the applied selection, the composer flags that they apply on
the next send.

Send detaches an immutable snapshot and its submission identity before the
network call. The next draft is committed in the same browser storage
write. Unknown acceptance remains visible in `SessionNotifications` and is
reconciled through the harness receipt under the same identity; it is never
replayed as a new submission. A definitely rejected submission can be
restored without overwriting newer active text. Offline Send is disabled,
and the client never builds a durable offline submission queue.

Drafts are partitioned by verified `harnessId`, principal, session, and a
fresh page-load writer identity. Another tab's saved record is an explicit
recovery candidate in `SessionNotifications`, never a shared writer slot.
Unsupported saved formats remain in storage and can be exported; no record
is silently deleted. Blocked storage leaves the current in-memory draft
editable with a persistent Not saved locally notice in `SessionNotifications`.

Waiting inputs appear as entries in `SessionNotifications`. Submitted user
entries are labelled with their mode and link to Session. Pending developer
work shows only an attributed count; full developer content stays in Session.

## History and questions

Rewind, inline edit, and fork controls appear only in Chat and use the
harness-issued history scope. Rewind previews the target and later history
and warns that it reruns immediately without rolling back external effects.
Clicking Edit transforms the user bubble in place with Cancel and Save
controls to edit and rerun. Long user messages fold at 300px
with a bottom fade and an inline Show more / Show less toggle. Sending a
message expands elastic room at the bottom of Chat so the new user bubble
pins near the top while the response streams beneath it. A stale scope
keeps the edit and does not retarget another boundary. A fork opens an
idle Chat view and copies neither the source draft nor synthetic input.

Questions and permission requests stay inline in Chat. Only the browser
whose connection owns the assigned action can answer. A steering message
resolves that browser's question as replied-by-message after input
acceptance; Queue leaves it open. Plain message text never approves a
permission request.

Session permission grants are managed under **Settings → Session &
Permissions**, which lists grants for the selected stored agent and
clears all grants for that agent after confirmation. It neither edits
permission rules nor revokes an individual grant.

## Attention and inbox

The sidebar separates **Working**, **Inbox**, and a collapsible **Filed**
section using authoritative harness activity, eligible pending input,
continuation, and assignment-validated human attention. A needs-human
hint never forces a view switch by itself; its indicator opens Chat and
reveals the request. An interaction assigned to another browser says so
and cannot be claimed or completed here.

Organization supports pin, read/unread, snooze, filing/reopening, and
conditional undo. Drag a session onto the **Filed** section or use the
row menu; organization changes do not cancel input, answer a request, or
alter execution. Explicit mark-unread advances a read generation so
delayed visibility samples cannot clear it. Manual filing requires fresh
quiescence. Inactivity filing defaults to three days and protects pinned,
opted-out, working, attention, and currently snoozed sessions.

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

The sign-in page queries `GET /v1/auth/methods` on the configured harness
and offers whichever sign-in methods the server accepts: **Continue with
GitHub**, a development password form, or both. For GitHub sign-in, the tab
keeps its verifier and endpoint in `sessionStorage`, removes the return
fragment before connecting, and exchanges the code once; password sign-in
keeps its verifier in memory and exchanges the returned code directly.
The access token stays in memory; the refresh token stays in this browser
under an endpoint-scoped key. Cross-tab refresh holds a bounded Web Lock.
When Web Locks are unavailable or cannot be acquired, no unlocked refresh
is attempted; recoverable drafts remain and the client asks for explicit
sign-in in a secure context. Revocation is shown as lost authorization,
not as ordinary expiry, and never switches principal automatically.
