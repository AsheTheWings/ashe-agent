import { describe, expect, test } from "bun:test"
import { CATALOG_BUDGET, renderCatalog, type CatalogTool } from "../src/tools/codemode/catalog.ts"

const tool = (path: string, description = "Does one thing for the test."): CatalogTool => ({
  path,
  description,
  signature: `${path.split(".").at(-1)}(input: { readonly query: string; readonly limit?: number }): Promise<{ readonly items: Array<string> }>`,
})

describe("code mode catalog", () => {
  test("an over-budget catalog stays within its budget, lists every namespace, and points to search", () => {
    const namespaces = Array.from({ length: 12 }, (_, index) => `server${String(index).padStart(2, "0")}`)
    const tools = namespaces.flatMap((namespace) => Array.from({ length: 40 }, (_, index) => tool(`${namespace}.tool_${index}`)))
    const full = tools.map((entry) => `  - ${entry.signature} // ${entry.description}`).join("\n")
    expect(full.length / 4).toBeGreaterThan(CATALOG_BUDGET)

    const catalog = renderCatalog(tools)!
    const listing = catalog.slice(catalog.indexOf("\n- server00") + 1)
    expect(listing.length).toBeLessThanOrEqual(CATALOG_BUDGET * 4)
    for (const namespace of namespaces) expect(catalog).toMatch(new RegExp(`^- ${namespace} \\(40 tools, \\d+ shown\\)$`, "m"))
    expect(catalog).toContain("The catalog is partial.")
    expect(catalog).toContain("find it with the global `search(...)` function")
    expect(catalog).toMatch(/^- search\(/m)
  })

  test("one namespace far over budget stays within it, at 4 characters per token", () => {
    const tools = Array.from({ length: 1_000 }, (_, index) => tool(`big.tool_${String(index).padStart(4, "0")}`))
    const catalog = renderCatalog(tools)!
    const listing = catalog.slice(catalog.indexOf("\n- big") + 1)
    expect(listing.length).toBeLessThanOrEqual(CATALOG_BUDGET * 4)
    expect(listing).toMatch(/^- big \(1000 tools, \d+ shown\)$/m)
    expect(catalog).toContain("The catalog is partial.")
  })

  test("a catalog within budget lists every tool and says it is complete", () => {
    const catalog = renderCatalog([tool("files.read", "Reads a file.\nMore detail."), tool("files.write")])!
    expect(catalog).toContain("The catalog is complete.")
    expect(catalog).not.toContain("search(")
    expect(catalog).toContain("- files (2 tools)")
    expect(catalog).toContain("  - read(input: { readonly query: string; readonly limit?: number }): Promise<{ readonly items: Array<string> }> // Reads a file.")
    expect(renderCatalog([])).toBeNull()
  })
})
