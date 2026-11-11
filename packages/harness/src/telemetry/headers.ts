import { Result } from "effect"

/**
 * Parses an OTLP headers file: one `name=value` per line, blank lines and
 * `#` comments skipped, the value taken exactly as written after the first
 * `=`. A problem names the line, never its content.
 */
export const parseOtlpHeaders = (text: string): Result.Result<Record<string, string>, string> => {
  const headers: Record<string, string> = {}
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue
    const at = line.indexOf("=")
    const name = at < 0 ? "" : line.slice(0, at).trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return Result.fail(`line ${index + 1} is not name=value`)
    headers[name] = line.slice(at + 1)
  }
  return Result.succeed(headers)
}
