import { renderProtocolJsonSchema } from "../packages/protocol/src/json-schema.ts"
import { renderConfigJsonSchema, renderDotEnv } from "../packages/server/src/inputs/render.ts"
import { renderSignalCatalog } from "../packages/server/src/telemetry/signals.ts"

/** Every tracked file generated from a source, with the content its source gives. */
export const generatedFiles = (): ReadonlyArray<{ readonly path: string; readonly content: string }> => [
  { path: ".env", content: renderDotEnv() },
  { path: "schemas/config.schema.json", content: renderConfigJsonSchema() },
  { path: "schemas/protocol.schema.json", content: renderProtocolJsonSchema() },
  { path: "schemas/signals.json", content: renderSignalCatalog() },
]
