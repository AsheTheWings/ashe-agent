/*
 * Ported from Codex, codex-rs/apply-patch/src/text_file.rs at f32b6cfd2bd,
 * Copyright 2025 OpenAI, licensed under the Apache License, Version 2.0
 * (see test/fixtures/codex-apply-patch/LICENSE and NOTICE).
 */

type Ending = "\n" | "\r\n" | "\r"

interface SourceLine {
  readonly text: string
  ending: Ending | null
}

/** A file's lines with each line's own ending, rebuilt after replacements. */
export class SourceFile {
  private constructor(
    private lines: Array<SourceLine>,
    private readonly preferred: Ending,
  ) {}

  /** Splits contents into lines keeping each ending; the first ending found is the one inserted lines take, else LF. */
  static parse(contents: string): SourceFile {
    const lines: Array<SourceLine> = []
    let preferred: Ending | null = null
    let lineStart = 0
    let cursor = 0
    while (cursor < contents.length) {
      const char = contents[cursor]
      let ending: Ending
      if (char === "\r") ending = contents[cursor + 1] === "\n" ? "\r\n" : "\r"
      else if (char === "\n") ending = "\n"
      else {
        cursor += 1
        continue
      }
      preferred ??= ending
      lines.push({ text: contents.slice(lineStart, cursor), ending })
      cursor += ending.length
      lineStart = cursor
    }
    if (lineStart < contents.length) lines.push({ text: contents.slice(lineStart), ending: null })
    return new SourceFile(lines, preferred ?? "\n")
  }

  lineTexts(): ReadonlyArray<string> {
    return this.lines.map((line) => line.text)
  }

  /**
   * Applies source-ordered, non-overlapping replacements of `[start,
   * removed, inserted]`: unchanged lines keep their endings, inserted lines
   * take the preferred one, and every line then ends with one.
   */
  applyReplacements(replacements: ReadonlyArray<readonly [number, number, ReadonlyArray<string>]>) {
    const next: Array<SourceLine> = []
    let index = 0
    for (const [start, removed, inserted] of replacements) {
      next.push(...this.lines.slice(index, start))
      next.push(...inserted.map((text) => ({ text, ending: this.preferred })))
      index = start + removed
    }
    next.push(...this.lines.slice(index))
    for (const line of next) line.ending ??= this.preferred
    this.lines = next
  }

  contents(): string {
    return this.lines.map((line) => line.text + (line.ending ?? "")).join("")
  }
}
