# Configuration

Every value ashe-agent reads as configuration is an *input*. One schema,
`packages/server/src/inputs/catalog.ts`, declares every input: its name,
its shape, whether it is configuration or protected, and its default in
each profile. Two files are generated from that schema and tracked:

- [`.env`](../.env) lists every process input with its development
  default, for reading. No process or tool loads it.
- [`schemas/config.schema.json`](../schemas/config.schema.json) describes
  the config file.

Run `bun run generate` after changing the schema; a conformance test fails
while either file differs from what the schema gives.

## Profiles

`ASHE_AGENT_PROFILE` selects `development` or `production` and has no
default. Each input's default applies only to the profiles it is safe for.
An input with no default in the selected profile is required, and a
process refuses to start without it. Production has no defaults for values
an operator must choose, such as the listen port and the model endpoint.

## Layers

A process merges its inputs from these layers, each overriding the ones
before it:

1. the schema's defaults for the selected profile;
2. the config file;
3. protected files;
4. process input, the environment variables the `.env` names.

Every layer is optional. An absent layer falls through; a present layer
that is unreadable or malformed stops the process. Each process validates
only the inputs it uses, after merging, and reports every invalid or
missing input by name before doing any other work. A report never
contains a protected value.

An invalid or absent profile stops the process too, and the other layers
are still checked so that their problems are reported with it. Without a
profile, an input falls back only to a default every profile shares, and
no input is reported missing.

## The config file

The config file is a JSON object whose keys are input names, such as
`listenPort` or `models`. `ASHE_AGENT_CONFIG_FILE` names it, by default
`$XDG_CONFIG_HOME/ashe-agent/config.json`. A missing file is skipped. A key
that is not an input or names a protected input makes the file invalid,
and so does a value the input's shape refuses. The profile and the config
file's own path come only from process input or their defaults, so the
file cannot set them either.

Values that are structured, such as the model list or the permission
rules, are JSON in process input too, for example
`ASHE_AGENT_MODELS='[{"id":"…","contextWindow":400000,"imageInput":false}]'`.

## Protected inputs

A protected input grants access or identity, such as the model API key.
Its value is read only from a file that a configuration input names, for
example `ASHE_AGENT_MODEL_API_KEY_FILE`, never from the config file or the
environment. The file must not be accessible to its group or others, and
its bytes are used exactly as stored, so a trailing newline becomes part
of the value.

## Paths

Path inputs must be absolute. Their defaults follow the XDG base
directories: configuration under `$XDG_CONFIG_HOME`, state under
`$XDG_STATE_HOME`, falling back to `~/.config` and `~/.local/state`.

## Models

Each configured model declares its id, its context window, and whether it
takes image input; the first is the default for new sessions. The list
must hold at least one model and no id twice. A model whose context
window is below 200,000 tokens is refused, and the server uses at most
480,000 tokens of any model's window.
