import { expect, test } from "bun:test"
import { diagnosticAttributes, diagnosticNames } from "../src/backend/diagnostics.ts"

test("the browser diagnostic intake names exactly the catalogued web signals", async () => {
  const catalog = await Bun.file(new URL("../../../schemas/signals.json", import.meta.url)).json() as { logs: Record<string, { attributes: string[] }> }
  const catalogued = Object.keys(catalog.logs).filter((name) => name.startsWith("web.")).sort()
  expect([...diagnosticNames].sort().join(",")).toBe(catalogued.join(","))
  for (const name of diagnosticNames) expect([...diagnosticAttributes[name]].sort().join(",")).toBe([...catalog.logs[name]!.attributes].sort().join(","))
})
