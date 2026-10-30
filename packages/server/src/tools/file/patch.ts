/*
 * The patch parser and context matching are ported from opencode v2.2.1,
 * packages/util/src/patch.ts, under the notice below. Keeping context lines
 * in place when replacing is ported from Codex,
 * codex-rs/apply-patch/src/file_update.rs at f32b6cfd2bd, Copyright 2025
 * OpenAI, licensed under the Apache License, Version 2.0 (see
 * test/fixtures/codex-apply-patch/LICENSE and NOTICE).
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

import { SourceFile } from "./line-endings.ts"

/** A patch that does not follow the format, with the reason the model reads. */
export class PatchParseError extends Error {}

export type Hunk =
  | { readonly type: "add"; readonly path: string; readonly contents: string }
  | { readonly type: "delete"; readonly path: string }
  | {
      readonly type: "update"
      readonly path: string
      readonly movePath?: string
      readonly chunks: ReadonlyArray<UpdateFileChunk>
    }

export interface UpdateFileChunk {
  readonly oldLines: ReadonlyArray<string>
  readonly newLines: ReadonlyArray<string>
  /** Pairs of indices into `oldLines` and `newLines` of the lines parsed as context. */
  readonly contextLines: ReadonlyArray<readonly [number, number]>
  readonly changeContext?: string
  readonly endOfFile?: boolean
}

const BOM = "\uFEFF"

const invalidHunk = (line: string, lineNumber: number, reason?: string) =>
  new PatchParseError(
    reason === undefined
      ? `Invalid hunk at line ${lineNumber}: '${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`
      : `Invalid hunk at line ${lineNumber}: ${reason}`,
  )

/** The hunks of a patch in Codex's format; throws `PatchParseError` for a malformed one. */
export function parse(patchText: string): ReadonlyArray<Hunk> {
  const lines = stripHeredoc(patchText.trim())
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
  const begin = lines[0]?.trim() === "*** Begin Patch" ? 0 : -1
  const end = lines.at(-1)?.trim() === "*** End Patch" ? lines.length - 1 : -1
  if (begin === -1) throw new PatchParseError("The first line of the patch must be '*** Begin Patch'")
  if (end === -1 || begin >= end) throw new PatchParseError("The last line of the patch must be '*** End Patch'")

  const hunks: Hunk[] = []
  let index = begin + 1
  while (index < end) {
    const line = lines[index]!
    const header = line.trim()
    if (header.startsWith("*** Add File: ")) {
      const path = header.slice("*** Add File: ".length).trim()
      const parsed = parseAdd(lines, index + 1, end, path)
      hunks.push({ type: "add", path, contents: parsed.content })
      index = parsed.next
      continue
    }
    if (header.startsWith("*** Delete File: ")) {
      const path = header.slice("*** Delete File: ".length).trim()
      const next = lines[index + 1]?.trim()
      if (index + 1 < end && next !== undefined && !isBoundary(next)) {
        if (next.startsWith("*** ")) throw invalidHunk(next, index + 2)
        throw invalidHunk(next, index + 2, `Unexpected line after Delete File '${path}': '${next}'. Delete hunks do not contain body lines`)
      }
      hunks.push({ type: "delete", path })
      index++
      continue
    }
    if (header.startsWith("*** Update File: ")) {
      const path = header.slice("*** Update File: ".length).trim()
      let next = index + 1
      let movePath: string | undefined
      while (lines[next]?.trimEnd() === "*** End of File") next++
      const move = lines[next]?.trimEnd()
      if (move === "*** Move to:" || move?.startsWith("*** Move to: ")) {
        movePath = move.slice("*** Move to: ".length).trim()
        if (!movePath) throw invalidHunk(lines[next]!.trim(), next + 1, `Move destination for '${path}' must not be empty`)
        next++
      }
      const parsed = parseUpdate(lines, next, end, path, index)
      hunks.push(movePath === undefined ? { type: "update", path, chunks: parsed.chunks } : { type: "update", path, movePath, chunks: parsed.chunks })
      index = parsed.next
      continue
    }
    throw invalidHunk(header, index + 1)
  }
  return hunks
}

/**
 * The contents of a file after an update's chunks, keeping a leading BOM
 * and each unchanged line's ending; inserted lines take the file's first
 * line ending, and every line ends with one.
 */
export function derive(path: string, chunks: ReadonlyArray<UpdateFileChunk>, original: string): string {
  const bom = original.startsWith(BOM)
  const source = SourceFile.parse(bom ? original.slice(BOM.length) : original)
  source.applyReplacements(computeReplacements(source.lineTexts(), path, chunks))
  return (bom ? BOM : "") + source.contents()
}

function parseAdd(lines: ReadonlyArray<string>, start: number, end: number, path: string): { content: string; next: number } {
  const content: string[] = []
  let index = start
  while (index < end && !isBoundary(lines[index]!.trim())) {
    if (!lines[index]!.startsWith("+")) {
      const line = lines[index]!.trim()
      throw invalidHunk(line, index + 1, `Invalid Add File line for '${path}': expected a line starting with '+', got '${line}'`)
    }
    content.push(lines[index]!.slice(1))
    index++
  }
  return { content: content.join("\n"), next: index }
}

function parseUpdate(
  lines: ReadonlyArray<string>,
  start: number,
  end: number,
  path: string,
  hunk: number,
): { chunks: ReadonlyArray<UpdateFileChunk>; next: number } {
  const chunks: Array<{
    oldLines: string[]
    newLines: string[]
    contextLines: Array<readonly [number, number]>
    changeContext?: string
    endOfFile?: boolean
  }> = []
  const pushContext = (chunk: (typeof chunks)[number], text: string) => {
    chunk.contextLines.push([chunk.oldLines.length, chunk.newLines.length])
    chunk.oldLines.push(text)
    chunk.newLines.push(text)
  }
  let index = start
  let afterEndOfFile = false
  while (index < end) {
    const line = lines[index]!
    const updateLine = line.trimEnd()
    if (afterEndOfFile) {
      if (updateLine === "") {
        index++
        continue
      }
      if (updateLine === "@@" || updateLine.startsWith("@@ ")) afterEndOfFile = false
      else if (isBoundary(updateLine)) break
      else throw invalidHunk(line, index + 1, `Expected update hunk to start with a @@ context marker, got: '${line}'`)
    }
    if (updateLine === "*** End of File") {
      const chunk = chunks.at(-1)
      if (chunk && chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
        throw invalidHunk(updateLine, index + 1, "Update hunk does not contain any lines")
      }
      if (chunk) {
        chunk.endOfFile = true
        afterEndOfFile = true
      }
      index++
      continue
    }
    if (isBoundary(updateLine)) break
    if (updateLine === "@@" || updateLine.startsWith("@@ ")) {
      const previous = chunks.at(-1)
      if (previous && previous.oldLines.length === 0 && previous.newLines.length === 0) {
        throw invalidHunk(
          line,
          index + 1,
          `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        )
      }
      chunks.push(
        updateLine === "@@"
          ? { oldLines: [], newLines: [], contextLines: [] }
          : { oldLines: [], newLines: [], contextLines: [], changeContext: updateLine.slice("@@ ".length) },
      )
      index++
      continue
    }
    if (chunks.length === 0) chunks.push({ oldLines: [], newLines: [], contextLines: [] })
    const chunk = chunks.at(-1)!
    if (line === "") {
      pushContext(chunk, "")
      index++
      continue
    }
    if (line.startsWith(" ")) {
      pushContext(chunk, line.slice(1))
      index++
      continue
    }
    if (line.startsWith("-")) {
      chunk.oldLines.push(line.slice(1))
      index++
      continue
    }
    if (line.startsWith("+")) {
      chunk.newLines.push(line.slice(1))
      index++
      continue
    }
    const populated = chunk.oldLines.length > 0 || chunk.newLines.length > 0
    throw invalidHunk(
      line,
      index + 1,
      populated
        ? `Expected update hunk to start with a @@ context marker, got: '${line}'`
        : `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
    )
  }
  if (chunks.length === 0) throw invalidHunk(lines[hunk]!.trim(), hunk + 1, `Update file hunk for path '${path}' is empty`)
  const last = chunks.at(-1)!
  if (last.oldLines.length === 0 && last.newLines.length === 0) {
    const line = lines[index]!.trim()
    throw invalidHunk(
      line,
      index + 1,
      line === "*** End Patch"
        ? "Update hunk does not contain any lines"
        : `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
    )
  }
  return { chunks, next: index }
}

function isBoundary(line: string) {
  return (
    line === "*** End Patch" ||
    line.startsWith("*** Add File: ") ||
    line.startsWith("*** Delete File: ") ||
    line.startsWith("*** Update File: ")
  )
}

/** A patch whose context does not match its file. */
export class PatchApplyError extends Error {}

function computeReplacements(lines: ReadonlyArray<string>, path: string, chunks: ReadonlyArray<UpdateFileChunk>) {
  const replacements: Array<readonly [start: number, remove: number, insert: ReadonlyArray<string>]> = []
  let lineIndex = 0
  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const context = seek(lines, [chunk.changeContext], lineIndex)
      if (context === -1) throw new PatchApplyError(`Failed to find context '${chunk.changeContext}' in ${path}`)
      lineIndex = context + 1
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([lines.length, 0, chunk.newLines])
      continue
    }
    let oldLines = chunk.oldLines
    let newLines = chunk.newLines
    let found = seek(lines, oldLines, lineIndex, chunk.endOfFile)
    if (found === -1 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1)
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1)
      found = seek(lines, oldLines, lineIndex, chunk.endOfFile)
    }
    if (found === -1 && chunk.oldLines.every((line) => line === "")) {
      const expected = chunk.oldLines.length === 1 ? "an expected blank line" : `${chunk.oldLines.length} consecutive blank lines`
      throw new PatchApplyError(`Failed to find ${expected} in ${path}`)
    }
    if (found === -1) throw new PatchApplyError(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`)
    // Context lines stay in place, so their exact contents and endings survive.
    let oldStart = 0
    let newStart = 0
    for (const [oldContext, newContext] of chunk.contextLines) {
      // A trailing empty context line may have been dropped above as the file's final newline.
      if (oldContext >= oldLines.length || newContext >= newLines.length) break
      if (oldStart !== oldContext || newStart !== newContext) {
        replacements.push([found + oldStart, oldContext - oldStart, newLines.slice(newStart, newContext)])
      }
      oldStart = oldContext + 1
      newStart = newContext + 1
    }
    if (oldStart !== oldLines.length || newStart !== newLines.length) {
      replacements.push([found + oldStart, oldLines.length - oldStart, newLines.slice(newStart)])
    }
    lineIndex = found + oldLines.length
  }
  return replacements.sort((left, right) => left[0] - right[0])
}

/** Where `pattern` first matches `lines` from `start`: exactly, else ignoring trailing, then surrounding whitespace, then after Unicode normalization. */
function seek(lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>, start: number, eof = false) {
  if (pattern.length === 0) return -1
  if (eof) {
    const offset = lines.length - pattern.length
    if (offset < start) return -1
    for (const compare of [exact, rstrip, trim, normalized]) {
      if (matches(lines, pattern, offset, compare)) return offset
    }
    return -1
  }
  for (const compare of [exact, rstrip, trim, normalized]) {
    for (let offset = start; offset <= lines.length - pattern.length; offset++) {
      if (matches(lines, pattern, offset, compare)) return offset
    }
  }
  return -1
}

function matches(lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>, offset: number, compare: (left: string, right: string) => boolean) {
  return pattern.every((line, index) => compare(lines[offset + index]!, line))
}

const exact = (left: string, right: string) => left === right
const rstrip = (left: string, right: string) => left.trimEnd() === right.trimEnd()
const trim = (left: string, right: string) => left.trim() === right.trim()
const normalized = (left: string, right: string) => normalize(left.trim()) === normalize(right.trim())
const normalize = (value: string) =>
  value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
const stripHeredoc = (input: string) => input.match(/^(?:cat\s+)?<<(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\s*$/)?.[3] ?? input
