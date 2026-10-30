import { Schema } from "effect"
import { SessionEventBody } from "./events.ts"
import { ClientRequest, ServerMessage } from "./jsonrpc.ts"
import { methodNames, methods } from "./methods.ts"

/**
 * The schemas the generated JSON Schema describes, by definition name: one
 * per message direction, then each method's params and result.
 */
export const jsonSchemaRoots = (): Record<string, Schema.Top> => {
  const roots: Record<string, Schema.Top> = {
    ClientRequest,
    ServerMessage,
    SessionEventBody,
  }
  for (const name of methodNames) {
    roots[`${name}.params`] = methods[name].params
    roots[`${name}.result`] = methods[name].result
  }
  return roots
}

/** A draft 2020-12 JSON Schema of one root, standing alone. */
export const toJsonSchema = (schema: Schema.Top): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(schema)
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    ...(Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}),
  }
}

/** The tracked protocol JSON Schema: every root under `$defs`, keyed by name. */
export const renderProtocolJsonSchema = (): string => {
  const $defs: Record<string, unknown> = {}
  for (const [name, schema] of Object.entries(jsonSchemaRoots())) {
    const { $schema: _, ...rest } = toJsonSchema(schema)
    $defs[name] = rest
  }
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "ashe-agent protocol",
    description:
      "Messages a client sends (ClientRequest) and a server sends (ServerMessage), as JSON-RPC 2.0 over one WebSocket.",
    anyOf: [{ $ref: "#/$defs/ClientRequest" }, { $ref: "#/$defs/ServerMessage" }],
    $defs,
  }
  return `${JSON.stringify(document, null, 2)}\n`
}
