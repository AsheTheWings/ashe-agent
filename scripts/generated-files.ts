import { renderConfigJsonSchema, renderDotEnv } from "../packages/server/src/inputs/render.ts"

/** Every tracked file generated from a source, with the content its source gives. */
export const generatedFiles = (): ReadonlyArray<{ readonly path: string; readonly content: string }> => [
  { path: ".env", content: renderDotEnv() },
  { path: "schemas/config.schema.json", content: renderConfigJsonSchema() },
]
