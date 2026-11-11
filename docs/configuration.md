# Configuration

Every value AsheAgent reads as configuration is an *input*. One schema,
`packages/harness/src/inputs/catalog.ts`, declares every input: its name,
its shape, whether it is configuration or protected, and its default in
each profile. Two files are generated from that schema and tracked:

- [`.env`](../.env) lists every process input with its development
  default, for reading. No process or tool loads it.
- [`schemas/config.schema.json`](../schemas/config.schema.json) describes
  the config file.

These two files own each input's name, shape, and default; the docs
explain how the inputs behave.

Run `bun run generate` after changing the schema; a conformance test fails
while either file differs from what the schema gives.

## Profiles

The profile selector chooses `development` or `production` and has no
default. Each input's default applies only to the profiles it is safe for.
An input with no default in the selected profile is required, and a
process refuses to start without it. Production has no defaults for values
an operator must choose, such as the listen port and the user's time
zone; the providers and the default model have no default in any profile.

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

The config file is a JSON object whose keys are input names. The config-file
input names its path, which lies under the XDG configuration directory by
default. A missing file is skipped. A key that is not an input or names a
protected input makes the file invalid, and so does a value the input's
shape refuses. The profile and the config file's own path come only from
process input or their defaults, so the file cannot set them either.

Values that are structured, such as the providers or the permission
rules, are JSON in process input too.
[Permissions](permissions.md) explains the rules.

## Protected inputs

A protected input grants access or identity, such as a provider's API
key. Its value is read only from a file that a configuration input names,
for example a provider's `apiKeyFile`, never from the config file or the
environment. The file must not be accessible to its group or others, and
its bytes are used exactly as stored, so a trailing newline becomes part
of the value.

## Paths

Path inputs must be absolute. Their defaults follow the XDG base
directories: configuration under `$XDG_CONFIG_HOME`, state under
`$XDG_STATE_HOME`, and cache under `$XDG_CACHE_HOME`, falling back to
`~/.config`, `~/.local/state`, and `~/.cache`.

The scratch root holds each session's scratch target, which the
session's `scratch` symlink points to. Its files are disposable and its
default is under the cache directory, so operators may place it on other
storage, such as a volume excluded from backups; the state directory
holds everything a session must keep. [Storage](storage.md#session-files)
explains both.

## The user's time zone

The user's time zone is an IANA zone name. The session facts and each
dates changed component give the user's date in it beside the server's
date in the server's own zone, as [model context](model-context.md#developer-components)
explains. Development defaults it to `UTC`; production requires it.

## Providers and models

`providers` maps each provider id to one OpenAI Responses endpoint: its
`baseURL`, the `apiKeyFile` holding its protected API key, and its
`models`, keyed by the provider's own model ids. A provider id holds no
`/`. A model's id is `<provider>/<model>`, such as `main/gpt-6.1` or
`router/org/model` for the model `org/model` of the provider `router`;
the server splits an id at its first `/` and sends the provider its own
model id. `serve` reads every provider's key file before it starts, and
the providers must register at least one model.

```json
{
  "providers": {
    "main": {
      "baseURL": "https://api.example.com/v1",
      "apiKeyFile": "/run/ashe-agent/main-api-key",
      "models": {
        "thinker": {
          "name": "Thinker",
          "limit": { "context": 400000 },
          "capabilities": { "input": ["text", "image"], "reasoning": { "efforts": ["low", "medium", "high"] } },
          "reasoningEffort": "medium"
        }
      }
    }
  },
  "defaultModel": "main/thinker"
}
```

Each model entry declares its input kinds, any of `text`, `image`, and
`pdf`; whether it accepts a temperature; and the reasoning efforts it
lists, if it reasons. Native PDF support is declared explicitly and is
never inferred from image support. Its settings, each optional, are the
`checkpointWindowSize`, the `temperature`, and the `reasoningEffort`. A
setting the capabilities do not allow is refused, such as an effort the
model does not list or a temperature for a model that accepts none, and
so is a `checkpointWindowSize` above `limit.context`. `name` is shown to
clients; it defaults to the id.

`defaultModel` is the model a session starts with when neither its agent
nor the request names one. Every model id an input names, the default
model's and each agent's included, must be registered.

### Selected and derived settings

A session's selection is its title, model id, and reasoning effort. A
requested selection can explicitly clear its model or effort; omission
preserves the applied value. Admission persists a new immutable selection
revision only when those selected values change. Reselecting a title
applies that title's model default and effort preset again. A model
change clears inherited effort the new model does not list; an explicitly
requested unsupported effort is admitted and fails execution.

Temperature and checkpoint window size are derived execution settings,
not persisted selections. At the next UserTurn, the active title's
per-model override supplies each value before the model entry's setting
and the default. A running AgentTurn keeps the values and title policy it
started with. A model call's reasoning effort is the first that the model
lists of the turn's selected effort and the model entry's setting.
[Agents and skills](agents-and-skills.md#agents) owns title selection and
[model context](model-context.md) explains what each call sends.

The server loads titles, model entries, and permission policy once at
startup. Changing them requires a restart.

### The working margin

A model's checkpoint window size for an agent is the agent's
`checkpointWindowSize` override for the model, else the model entry's
setting, else `limit.context` capped at 480,000 tokens. After the seed's
allowance of 106,000 tokens, 4,000 for tool definitions, and a reserve of
40,000, each model and agent pair must leave a working margin of at
least 100,000 tokens. The check covers every configured model with every
agent and with the implicit agent, and a pair below the margin stops the
process, naming the model, the agent, and the margin.

### Auxiliary models

The auxiliary models name the model of each auxiliary task: `compaction`
and `research`, which summarize conversation and research files into
timeline entries, and `handoff`, which summarizes a checkpoint window
that filled up. Each is optional and must be registered; a task without
one runs on the model of the session's latest turn. An auxiliary call
uses its model's own settings, and the latest turn's effort selection
only when it runs on that turn's model.
[Model context](model-context.md) explains the tasks.

The model and graph libraries' own process variables configure nothing:
`serve` removes them, as [model context](model-context.md) explains.

### Content conversion

PDF page rendering and text extraction run in short-lived child processes
launched through util-linux `prlimit`, never in the server process. The
worker receives only the selected bytes, verifies its own data, stack, and
CPU limits before opening them, and runs under a parent-enforced wall
deadline and output ceiling. Active and queued work are bounded separately,
and cancellation, failure, or overflow reaps the worker without an
unrestricted fallback. [Content](content.md#pdf-conversion) owns the
representation routes and [trust model](trust-model.md) states the limits
of this isolation.

## Changing configuration

The server reads its inputs once, at start. Changing the providers, the
agents, the default agent, or any other input takes a server restart.
Title files, the global instructions file, and the skills are read when a
session is created and again with each delivery into a turn, as
[agents and skills](agents-and-skills.md#title-files-and-user-instructions)
explains. Their changes reach a running session only at a UserTurn
boundary; they do not replace the active AgentTurn's profile.

## Finite execution budgets

The tool timeout inputs configure one elapsed-time policy for every tool
invocation. A global limit is a positive duration in milliseconds. Exact
overrides are keyed by registered tool name, with each value a positive
duration or `null`. An exact override replaces the global limit, and
`null` removes only that local limit, not an ancestor's deadline or
cancellation. The schema owns the input names, shapes, and profile
defaults.

The budget runs from before validation through permission collection,
execution, and settlement. A code mode child inherits the earlier of its
own and its parent's deadline. [Tools](tools.md#execution-budget) owns the
observable timeout and partial-effect behavior; [code mode](code-mode.md#limits)
owns its call and output limits.

## What else the inputs configure

The schema names every input; these docs explain what each group does:

- [Permissions](permissions.md): the permission rules.
- [Agents and skills](agents-and-skills.md): the agents, the default
  agent, the titles directory, the global instructions file, and the
  skill roots.
- [Tools](tools.md): the shell defaults, such as each command's yield
  time, output budget, and environment file, and the processes a session
  may hold; the Exa API key file, whose presence offers the web tools; and
  the MCP servers, each reached over stdio or Streamable HTTP.
- [Code mode](code-mode.md): the limits on each program's tool calls
  and output.
- [Telemetry](telemetry.md): the exporter for each signal, the OTLP
  endpoint and its protocol, the protected file of export headers, and
  the deployment environment every signal reports.
