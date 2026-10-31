/*
 * The catalog summary and its instructions are ported from opencode v2.2.1,
 * packages/core/src/codemode/catalog.ts and instructions.ts, under the
 * notice below.
 *
 * MIT License
 *
 * Copyright (c) 2025 opencode
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { searchSignature } from "@ashe-agent/codemode"
import { CHARACTERS_PER_TOKEN, CODE_MODE_CATALOG_ALLOWANCE } from "../../context/constants.ts"

/** A callable tool of the code mode inventory: its path under `tools`, description, and signature. */
export interface CatalogTool {
  readonly path: string
  readonly description: string
  readonly signature: string
}

interface Listing {
  readonly path: string
  readonly line: string
}

interface NamespaceSummary {
  readonly name: string
  readonly count: number
  readonly entries: ReadonlyArray<Listing>
}

/** The tools a catalog lists, by namespace, out of `total`. */
export interface CatalogSummary {
  readonly total: number
  readonly shown: number
  readonly namespaces: ReadonlyArray<NamespaceSummary>
}

/** The catalog's budget, in estimated tokens: the seed's code mode catalog allowance. */
export const CATALOG_BUDGET = CODE_MODE_CATALOG_ALLOWANCE
const DESCRIPTION_LIMIT = 120

const byCodePoint = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

/** A line's estimated tokens, its newline included, rounded up so the listing never exceeds the budget. */
export const cost = (line: string) => Math.ceil((line.length + 1) / CHARACTERS_PER_TOKEN)

/**
 * Keeps every namespace visible, then selects full listings one per
 * namespace per round, shorter listings first, until the budget is spent.
 */
export const summarize = (tools: ReadonlyArray<CatalogTool>, budget = CATALOG_BUDGET): CatalogSummary => {
  const namespaces = [...Map.groupBy(tools, (tool) => tool.path.split(".", 1)[0] ?? tool.path)]
    .sort(([left], [right]) => byCodePoint(left, right))
    .map(([name, entries]) => {
      const listings = entries
        .map((entry) => {
          const firstLine = entry.description.split("\n", 1)[0]?.trim() ?? ""
          const description = firstLine.length > DESCRIPTION_LIMIT ? firstLine.slice(0, DESCRIPTION_LIMIT - 3) + "..." : firstLine
          return { path: entry.path, line: `  - ${entry.signature}${description.length === 0 ? "" : ` // ${description}`}` }
        })
        .toSorted((left, right) => byCodePoint(left.path, right.path))
      const selectionOrder = listings
        .map((listing) => ({ listing, cost: cost(listing.line) }))
        .toSorted((left, right) => left.cost - right.cost || byCodePoint(left.listing.path, right.listing.path))
      return { name, listings, selectionOrder, selected: new Set<Listing>(), index: 0 }
    })

  const active = new Set(namespaces)
  let remaining =
    budget - namespaces.reduce((total, namespace) => total + cost(namespaceLine({ name: namespace.name, count: namespace.listings.length, entries: [] })), 0)
  while (active.size > 0) {
    for (const namespace of active) {
      const candidate = namespace.selectionOrder[namespace.index]
      if (candidate === undefined || candidate.cost > remaining) {
        active.delete(namespace)
        continue
      }
      namespace.selected.add(candidate.listing)
      namespace.index += 1
      remaining -= candidate.cost
      if (namespace.index === namespace.selectionOrder.length) active.delete(namespace)
    }
  }

  const summaries = namespaces.map((namespace) => ({
    name: namespace.name,
    count: namespace.listings.length,
    entries: namespace.listings.filter((listing) => namespace.selected.has(listing)),
  }))
  return { total: tools.length, shown: summaries.reduce((total, namespace) => total + namespace.entries.length, 0), namespaces: summaries }
}

export const namespaceLine = (namespace: NamespaceSummary) => {
  const count = namespace.count === 1 ? "1 tool" : `${namespace.count} tools`
  const label =
    namespace.entries.length === namespace.count
      ? count
      : namespace.entries.length === 0
        ? `${count}, none shown`
        : `${count}, ${namespace.entries.length} shown`
  return `- ${namespace.name} (${label})`
}

// The developer message's "Code mode" section supplies the top heading.
const prompt = (partial: boolean) => `The tools listed below${partial ? ", and \`search\`," : ""} cannot be called directly: they only work as JavaScript inside the \`execute\` tool. Every other tool you have is a normal tool call: call it directly, never inside \`execute\`.

${
  partial
    ? `The catalog is partial. Before calling a tool that is not listed below, find it with the global \`search(...)\` function. Do not guess tool names. Each result's \`path\` is the complete call expression: write it out as code, for example \`await tools.ns.tool_name({ ... })\`. Do not use it as a key such as \`tools[path]\`.

- ${searchSignature}`
    : "The catalog is complete. Do not guess tool names."
}

## Code Mode tools (call only inside \`execute\`)`

/** The code mode catalog of the developer message, within the budget; null for an empty inventory. */
export const renderCatalog = (tools: ReadonlyArray<CatalogTool>, budget = CATALOG_BUDGET): string | null => {
  if (tools.length === 0) return null
  const summary = summarize(tools, budget)
  const lines = summary.namespaces.flatMap((namespace) => [namespaceLine(namespace), ...namespace.entries.map((entry) => entry.line)])
  return `${prompt(summary.shown < summary.total)}\n\n${lines.join("\n")}`
}
