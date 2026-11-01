# Telemetry

The server emits traces, metrics, and logs through OpenTelemetry only. The
entry point starts the SDK before any other work; the rest of the server
uses the OpenTelemetry API, and Effect's spans and metrics reach the same
SDK through `@effect/opentelemetry`. Command output, such as the URL
`serve` prints and the problems a command reports, is not telemetry.

## Signals

`packages/server/src/telemetry/signals.ts` is the signal catalog: every
span, metric, and log record with its attributes, units, and error
classes, under a version that changes with any of them.
`schemas/signals.json` is generated from it with `bun run generate`.

- A span covers each protocol request, authentication included, each turn,
  each model call, and each tool call.
  A code mode program's tool calls are child spans of their `execute` call.
- Context work has spans of its own: each context turn, a child of its
  turn's span; each tool result clearing, compaction, research, and
  handoff call, validation, and checkpoint window construction; each
  `context_ask_question` wait; and each reconciliation of a delivery's
  sources, memory check, memory publish, turn snapshot, and rewind
  restore, as children of the running turn's span when there is one.
- Histograms record turn, model call, and tool call durations in seconds.
- Histograms record the estimated tokens each clearing freed and each
  built checkpoint window's estimated size, its harness instructions and
  seed; a counter counts failed validations.
- Log records report protocol requests that failed with an internal
  error, MCP servers that failed to connect or were lost, and MCP tool
  names that collide; a collision record names the shared registered
  name and each colliding tool with its server.

Attributes are bounded: configured model ids, registered tool names,
configured MCP server names, protocol method names, outcomes, attempt
numbers, and error classes. A failed turn whose failure code is an error
class, such as `compaction_failed`, carries that class; a reconciliation
or construction that could not read the user instructions carries
`user_instructions_unreadable`. A method or tool name that the protocol
or the offered tools do not define is recorded as `unknown`. No signal
carries prompts, model
output, tool arguments or results, shell commands or output, file
contents, search queries, URLs, program code, passwords, or tokens, nor
timeline entries, component text, questions, answers, or feedback; a log
record's body is its catalog description.

Every signal carries `service.namespace` `ashe-agent`, `service.name`
`ashe-agent-server`, `service.version` set to the build revision, a
`service.instance.id` new for each process, and
`deployment.environment.name` from the server's input.

## Export

Each signal's exporter is `otlp`, `console`, or `none`, selected by the
standard `OTEL_*_EXPORTER` inputs. The `otlp` exporters send over HTTP,
as protobuf or JSON, to `<endpoint>/v1/traces`, `/v1/metrics`, and
`/v1/logs`. Export headers, which may carry the endpoint's credentials,
come only from a protected file of `name=value` lines; the server sends
them with every export and never records them. A malformed headers file
stops `serve` before it starts, naming the line, never its content.

Spans and log records leave in batches and metrics every 60 seconds, each
export bounded by 10 seconds. A failed export is dropped, with no other
destination. When `serve` stops, it flushes what it holds within 10
seconds. [Configuration](configuration.md) describes how inputs reach the
server.
