# Configuration

Every value AsheAgent reads as configuration is an *input*. One schema,
`packages/server/src/inputs/catalog.ts`, declares every input: its name,
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

`ASHE_AGENT_PROFILE` selects `development` or `production` and has no
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

The config file is a JSON object whose keys are input names, such as
`listenPort` or `providers`. `ASHE_AGENT_CONFIG_FILE` names it, by default
`$XDG_CONFIG_HOME/ashe-agent/config.json`. A missing file is skipped. A key
that is not an input or names a protected input makes the file invalid,
and so does a value the input's shape refuses. The profile and the config
file's own path come only from process input or their defaults, so the
file cannot set them either.

Values that are structured, such as the providers or the permission
rules, are JSON in process input too, for example
`ASHE_AGENT_PERMISSION='{"edit":"ask"}'`.
[Permissions](permissions.md) explains the rules.

## Protected inputs

A protected input grants access or identity, such as a provider's API
key. Its value is read only from a file that a configuration input names,
for example `ASHE_AGENT_EXA_API_KEY_FILE` or a provider's `apiKeyFile`,
never from the config file or the environment. The file must not be accessible to its group or others, and
its bytes are used exactly as stored, so a trailing newline becomes part
of the value.

## Paths

Path inputs must be absolute. Their defaults follow the XDG base
directories: configuration under `$XDG_CONFIG_HOME`, state under
`$XDG_STATE_HOME`, and cache under `$XDG_CACHE_HOME`, falling back to
`~/.config`, `~/.local/state`, and `~/.cache`.

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

Each model entry declares its capabilities: the input it takes, `text`
alone or with `image`; whether it accepts a temperature; and the
reasoning efforts it lists, if it reasons. Its settings, each optional,
are the `checkpointWindowSize`, the `temperature`, and the
`reasoningEffort`. A setting the capabilities do not allow is refused,
such as an effort the model does not list or a temperature for a model
that accepts none, and so is a `checkpointWindowSize` above
`limit.context`. `name` is shown to clients; it defaults to the id.

`defaultModel` is the model a session starts with when neither its agent
nor the request names one. Every model id an input names, the default
model's and each agent's included, must be registered.

A model call's reasoning effort is the first that the model lists of the
session's selection when the turn started, the agent's override for the
model, and the model entry's setting. Its temperature is the agent's
override, else the model entry's setting, and is sent only to a model
that accepts one. [Model context](model-context.md) explains what each
call sends.

### The working margin

A model's checkpoint window size for an agent is the agent's
`checkpointWindowSize` override for the model, else the model entry's
setting, else `limit.context` capped at 480,000 tokens. After the seed's
allowance of 106,000 tokens, 4,000 for tool definitions, and a reserve of
40,000, each model and agent pair must leave a working margin of at
least 100,000 tokens. The check covers every configured model with every
agent and with the implicit agent, and a pair below the margin stops the
process, naming the model, the agent, and the margin.

The model and graph libraries' own process variables, such as
`OPENAI_BASE_URL` or `LANGSMITH_TRACING`, configure nothing: `serve`
removes them, as [model context](model-context.md) explains.

## Changing configuration

The server reads its inputs once, at start. Changing the providers, the
agents, the default agent, or any other input takes a server restart.
Title files and the global instructions file are read when a session is
created, and skills at each turn, as
[agents and skills](agents-and-skills.md) explains.

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
- [Code mode](code-mode.md): the limits on each program's time, tool
  calls, and output.
- [Telemetry](telemetry.md): the exporter for each signal, the OTLP
  endpoint and its protocol, the protected file of export headers, and
  the deployment environment every signal reports.
