/** A Markdown file's YAML frontmatter, as an object, and its body; or why the frontmatter cannot be read. */
export type Parsed =
  | { readonly ok: true; readonly data: Record<string, unknown>; readonly body: string }
  | { readonly ok: false; readonly reason: string }

const OPEN = /^---\r?\n/
const CLOSE = /^---\s*$/m

/**
 * Splits `---`-fenced YAML frontmatter from a Markdown body. A file without
 * frontmatter has an empty one; frontmatter that is not a YAML mapping is
 * refused.
 */
export const parseFrontmatter = (text: string): Parsed => {
  const content = text.startsWith("\uFEFF") ? text.slice(1) : text
  const open = OPEN.exec(content)
  if (open === null) return { ok: true, data: {}, body: content }
  const rest = content.slice(open[0].length)
  const close = CLOSE.exec(rest)
  if (close === null) return { ok: false, reason: "its frontmatter has no closing ---" }
  const yaml = rest.slice(0, close.index)
  const body = rest.slice(close.index + close[0].length).replace(/^\r?\n/, "")
  let data: unknown
  try {
    data = yaml.trim() === "" ? {} : Bun.YAML.parse(yaml)
  } catch (error) {
    return { ok: false, reason: `its frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "its frontmatter is not a YAML mapping" }
  return { ok: true, data: data as Record<string, unknown>, body }
}
