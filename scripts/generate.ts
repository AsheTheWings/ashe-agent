/** Writes the files generated from the input schema. */
import { join } from "node:path"
import { generatedFiles } from "./generated-files.ts"

const root = join(import.meta.dir, "..")
for (const file of generatedFiles()) {
  await Bun.write(join(root, file.path), file.content)
  process.stdout.write(`wrote ${file.path}\n`)
}
