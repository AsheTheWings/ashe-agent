import { Redacted, Result } from "effect"
import { readDiskFile } from "../../inputs/bootstrap.ts"
import { readProtectedFile, type Sources } from "../../inputs/resolve.ts"

/** Lines that are neither blank nor `#` comments. */
const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim() !== "" && !line.trimStart().startsWith("#"))

/**
 * Parses an env file: one `NAME=value` per line, the value taken exactly
 * as written after the first `=`. Problems name the line, never its value.
 */
export const parseEnvFile = (text: string): Result.Result<Record<string, string>, string> => {
  const env: Record<string, string> = {}
  for (const { line, number } of lines(text)) {
    const at = line.indexOf("=")
    const name = at < 0 ? "" : line.slice(0, at)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return Result.fail(`line ${number} is not NAME=value`)
    env[name] = line.slice(at + 1)
  }
  return Result.succeed(env)
}

/**
 * Parses a headers file: one `Name: value` per line, the value taken after
 * the colon and the spaces that follow it. Problems name the line, never
 * its value.
 */
export const parseHeadersFile = (text: string): Result.Result<Record<string, string>, string> => {
  const headers: Record<string, string> = {}
  for (const { line, number } of lines(text)) {
    const at = line.indexOf(":")
    const name = at < 0 ? "" : line.slice(0, at)
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return Result.fail(`line ${number} is not Name: value`)
    headers[name] = line.slice(at + 1).replace(/^[ \t]+/, "")
  }
  return Result.succeed(headers)
}

/**
 * Reads a protected credentials file and parses it, redacted; a problem
 * names the file and the reason, never a value.
 */
export const readCredentials = (
  path: string,
  parse: (text: string) => Result.Result<Record<string, string>, string>,
  readFile: Sources["readFile"] = readDiskFile,
): Result.Result<Redacted.Redacted<Record<string, string>>, string> => {
  const read = readProtectedFile(path, readFile)
  if (Result.isFailure(read)) return Result.fail(`${path} ${read.failure}`)
  const parsed = parse(Redacted.value(read.success))
  if (Result.isFailure(parsed)) return Result.fail(`${path}: ${parsed.failure}`)
  return Result.succeed(Redacted.make(parsed.success))
}
