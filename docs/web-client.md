# Web client

`packages/web` is a static React application that works with a server's
sessions from the browser. The server does not serve it; any static file
host can, and the browser connects from there to the server's WebSocket
endpoint.

## Run and build

```sh
bun run dev:web
```

from the repository root serves the client for development on `127.0.0.1`, on Vite's port. The
server accepts a browser connection only from an origin that
`ASHE_AGENT_ORIGINS` lists, so that input must name the origin the
client is served from; see [configuration](configuration.md).

`bun run build:web`, from the repository root, builds the client into
`packages/web/dist` and writes the commit it was built from to
`revision.txt` at the build's root. It refuses a worktree with changes,
since the build would hold code no commit has.

## Container image

The web image serves that build with Caddy, from a base image pinned by
digest. `bun run web-image`, from a commit with no uncommitted changes
and with `ORAS` naming an `oras` executable, builds the client and its
image and writes the image, annotated, to the OCI layout
`dist/web-image` under the tag `qualified`. It runs the two steps of
`scripts/image.sh`: `build web <layout> <revision> <created>` packages
`packages/web/dist`, which must hold the revision's `revision.txt`, with
`packages/web/image/` into an OCI layout, refusing a worktree with
changes or not at the revision, and `push` writes that image, annotated
with the `org.opencontainers.image` revision, source, run URL, creation
time, and version, to another layout or to a registry. The container listens on
port 8080 as UID 65532, needs a writable `/data` and `/config`, such as
tmpfs mounts, and otherwise runs read-only. It serves the files under
`/assets/` as immutable and every other file as `no-cache`, answers a
missing file with 404 and no cache header, and writes no logs: Caddy's
admin API, access logs, and console logs are off.

[`compose.yaml`](../compose.yaml) is a reference deployment on
`127.0.0.1:8080` of the image named `localhost/ashe-agent-web`. Give a
built image that name before starting it:

```sh
podman pull oci:dist/web-image:qualified
podman tag <image id it prints> localhost/ashe-agent-web
podman compose up -d
```

The image's client connects to whichever server its user enters at
sign-in, so serve it from an origin that server's `ASHE_AGENT_ORIGINS`
lists, and run both from one commit, since the protocol may change at any
revision.

## Signing in

The sign-in page asks for the server's WebSocket URL, such as
`ws://host:port/v1/ws`, and the owner password. The browser remembers the
URL for the next visit. The client keeps the access token in memory and
the refresh token in `localStorage`, and exchanges the refresh token for a
new pair a minute before the access token expires, on a connection of
its own. On a later visit, a stored refresh token signs the client in
without the password. Signing out forgets the refresh token in this
browser only; the login stays valid until it expires or the password
changes.

Presenting a refresh token that was already exchanged signs the whole
login out, as [authentication](authentication.md) explains. Pages of one
origin share the stored token, so each exchange holds a Web Lock that
every page of the origin shares and reads the stored token inside it.
Browsers offer Web Locks only in secure contexts, HTTPS or `127.0.0.1`;
elsewhere two pages that refresh at the same moment can present the same
token and sign the login out.

When the connection drops, the client reconnects after a delay that
doubles from one second up to thirty, and resubscribes to the open
session from the last event it saw.

## Sessions

The sidebar lists the server's sessions. A new session takes a model
from the server's model list, shown by name, a reasoning effort the
model lists, and, optionally, an agent; an agent that names a model
starts the session with it. The effort list marks the default: the
agent's override for the model, else the model's own setting. The agent
list shows each agent's title and its title file's description, or that
an agent without a title file uses the global user instructions. A
session starts in its own session directory, which the session's header
shows along with its selected model and effort. Choosing another model
there switches the session's model from its next turn, at the model's
default effort; choosing another effort keeps the model.

Input steers the running turn, or starts one when the session is idle.
With the queue switch on, input waits for the running turn to end
instead. The stop button cancels the running turn. A message shows as
waiting above the composer until a turn receives it, as one held for a
context turn's continuation does.

A tool call waiting on a permission shows the request inside the call,
with allow once, always allow, and reject. A note typed beside the
request goes with a rejection, as the call's result; the request
disappears once answered here or by another client, or withdrawn. A call
can wait on several requests at once, as a code mode program's
concurrent calls do: the call shows the first, and a list above the
conversation shows the others, with the same answers.

Model text renders as Markdown. Raw HTML in it shows as text and is
never rendered.

## Context work

The conversation shows every item of the session, every checkpoint
window included, with the context work between them:

- each timeline entry where it was recorded, with its kind and number,
  a compaction entry with its current text, and an open or problem entry
  marked with the `done` entry that resolved it;
- each developer message where it was delivered, collapsed to its
  components' headings;
- marks where a context turn starts, at each tool result clearing, at
  each failed context check, where each checkpoint window after the
  first begins, and at each continuation turn and each turn a developer
  message started;
- each session error with its message.

A question set the agent asks shows its feedback first, then each
question's header and text with its options, a note, and skip. Sending
it answers the set for every client; a note over 2,000 characters keeps
the form from sending and says so. Once answered, or once its call
ends, the set shows what was answered.

## Rewind and fork

Each input that started a turn offers rerun, edit and rerun, and fork
through that turn, while no turn runs. An input that steered a running
turn has no turn of its own, and a turn a developer message started
holds no input, so neither offers them. Rerun and edit remove that turn
and every later one from the session before running the input, or the
edited text, again. Research and memory files return to their state
when that turn started, while scratch, other files, and other effects of
the removed turns stay as they are; the client says so before it
rewinds. Fork copies the session through that turn into a new session
and opens it.
