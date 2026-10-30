/*
 * Ported from Tera's Exa tools, src/exa/tools.ts at bacd9b0: the
 * arguments, the `category:` lifting, the requests, and the renderings.
 */

import { Schema } from "effect"
import { builtinTool, type Tool, type ToolResult } from "../../agent/tools.ts"
import { ExaError, errorTag, records, type ExaClient } from "./exa.ts"

const Count = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))

const SearchArgs = Schema.Struct({
  query: Schema.NonEmptyString.annotate({
    description:
      "Natural language search query. Describe the ideal page rather than supplying only keywords; category:company or category:people may be included.",
  }),
  numResults: Schema.optionalKey(Count.annotate({ description: "Number of search results to return (default: 10)" })),
})

/** An absolute http or https URL. */
const WebUrl = Schema.String.check(
  Schema.makeFilter((value: string) => {
    const url = URL.parse(value)
    return (url !== null && (url.protocol === "http:" || url.protocol === "https:")) || "is not an absolute http or https URL"
  }),
)

const FetchArgs = Schema.Struct({
  urls: Schema.Array(WebUrl)
    .check(Schema.isMinLength(1), Schema.isMaxLength(100))
    .annotate({ description: "URLs to read; batch multiple URLs in one call" }),
  maxCharacters: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "Maximum characters to extract per page (default: 3000)" }),
  ),
})

const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback)

const searchText = (body: Record<string, unknown>) => {
  const results = records(body.results)
  if (results.length === 0) return "No search results found. Please try a different query."
  return results
    .map((result) => {
      const lines = [
        `Title: ${text(result.title, "N/A")}`,
        `URL: ${text(result.url, "N/A")}`,
        `Published: ${text(result.publishedDate, "N/A")}`,
        `Author: ${text(result.author, "N/A")}`,
      ]
      const highlights = Array.isArray(result.highlights) ? result.highlights.filter((value) => typeof value === "string") : []
      if (highlights.length > 0) lines.push(`Highlights:\n${highlights.join("\n")}`)
      else if (typeof result.text === "string") lines.push(`Text: ${result.text}`)
      return lines.join("\n")
    })
    .join("\n\n---\n\n")
}

const fetchedText = (body: Record<string, unknown>) => {
  const lines: Array<string> = []
  for (const result of records(body.results)) {
    lines.push(`# ${text(result.title, "(no title)")}`, `URL: ${text(result.url, "N/A")}`)
    if (typeof result.publishedDate === "string") lines.push(`Published: ${result.publishedDate.split("T")[0]}`)
    if (typeof result.author === "string") lines.push(`Author: ${result.author}`)
    lines.push("")
    if (typeof result.text === "string") lines.push(result.text)
    lines.push("")
  }
  for (const status of records(body.statuses)) {
    if (status.status !== "error") continue
    lines.push(`Error fetching ${text(status.id, "URL")}: ${text(errorTag(status), "unknown error")}`)
  }
  return lines.join("\n").trim() || "No content found for the provided URL(s)."
}

const failed = (name: string, error: unknown): ToolResult => {
  if (!(error instanceof ExaError)) throw error
  const detail = error.status === null ? `upstream ${error.tag}` : `upstream HTTP ${error.status}${error.tag === null ? "" : ` (${error.tag})`}`
  return { outcome: "failed", content: `${name} failed: ${detail}` }
}

const CATEGORY = /\bcategory:(company|publication|news|personal\s*site|people)\b/i

/**
 * `web_search` and `web_fetch` over Exa. The server sends Exa the query
 * or the URLs and never connects to a URL itself. Rules under the `web`
 * permission match the query and each URL.
 */
export const webTools = (exa: ExaClient): ReadonlyArray<Tool> => [
  builtinTool({
    namespace: "web",
    name: "search",
    description:
      "Search the web for any topic and get clean, ready-to-use content. Use web_fetch on promising URLs when highlights are insufficient.",
    args: SearchArgs,
    prepare: (args) => ({ check: { permission: "web", subjects: [args.query], patterns: [args.query] }, plan: undefined }),
    run: async (args, run) => {
      const category = CATEGORY.exec(args.query)
      const query = category === null ? args.query : args.query.replace(category[0], "").replace(/\s+/g, " ").trim()
      try {
        const body = await exa.post(
          "/search",
          {
            query,
            type: "auto",
            numResults: args.numResults ?? 10,
            ...(category === null ? {} : { category: category[1]!.toLowerCase().replace(/\s+/g, " ") }),
            contents: { highlights: true },
          },
          run.signal,
        )
        return { outcome: "success", content: searchText(body) }
      } catch (error) {
        return failed("web_search", error)
      }
    },
  }),
  builtinTool({
    namespace: "web",
    name: "fetch",
    description:
      "Read one or more webpages as clean Markdown. Use after web_search when highlights are insufficient or when the URLs are already known.",
    args: FetchArgs,
    prepare: (args) => ({ check: { permission: "web", subjects: [...args.urls], patterns: [...args.urls] }, plan: undefined }),
    run: async (args, run) => {
      try {
        const body = await exa.post("/contents", { urls: args.urls, text: { maxCharacters: args.maxCharacters ?? 3000 } }, run.signal)
        return { outcome: "success", content: fetchedText(body) }
      } catch (error) {
        return failed("web_fetch", error)
      }
    },
  }),
]
