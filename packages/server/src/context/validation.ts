import { ENTRY_FIELD_MAX_LENGTH, MEMORY_FILES_MAX } from "./constants.ts"
import { codePoints, frontmatterDescription, parseHeader, type Entry } from "./entries.ts"

/** One entry of `research/` or `memory-draft/`: its name and, for a regular Markdown file, its text. */
export interface AreaEntry {
  readonly name: string
  /** The file's text, or null for anything but a regular `.md` file. */
  readonly text: string | null
}

/** What validation found: the research violations, the secondary timeline violations, and the draft's entry count. */
export interface Violations {
  readonly research: ReadonlyArray<string>
  readonly memory: ReadonlyArray<string>
  /** How many entries `memory-draft/` holds. */
  readonly count: number
}

export const violationCount = (violations: Violations) => violations.research.length + violations.memory.length

const notMarkdown = (path: string) => `\`${path}\` is not a Markdown file directly inside \`research/\` or \`memory-draft/\`.`
const noDescription = (path: string) => `\`${path}\` has no \`description:\` frontmatter of 1 to ${ENTRY_FIELD_MAX_LENGTH} characters.`

/** The over-count violation, which a context turn component states on its own line. */
export const overCount = (count: number) => `\`memory-draft/\` holds ${count} files; at most ${MEMORY_FILES_MAX} are allowed.`

const describedProblem = (path: string, text: string): string | null => {
  const description = frontmatterDescription(text)?.description ?? null
  if (description === null || /[\r\n]/.test(description)) return noDescription(path)
  const length = codePoints(description)
  return length < 1 || length > ENTRY_FIELD_MAX_LENGTH ? noDescription(path) : null
}

/** The research violations: entries other than regular Markdown files, and files without a description. */
export const researchViolations = (research: ReadonlyArray<AreaEntry>): ReadonlyArray<string> =>
  research.flatMap((entry) => {
    const path = `research/${entry.name}`
    if (entry.text === null) return [notMarkdown(path)]
    const problem = describedProblem(path, entry.text)
    return problem === null ? [] : [problem]
  })

/**
 * The entry blocks of a secondary timeline's body from line index `first`
 * on, the first line outside every entry, and the numbers of the entries
 * whose header directly follows the previous entry's last line.
 */
const parseTimeline = (text: string, first: number) => {
  const lines = text.split("\n")
  const blocks: Array<{ readonly number: number; readonly text: string }> = []
  const unseparated: Array<number> = []
  let current: { readonly number: number; readonly lines: Array<string> } | null = null
  let stray: number | null = null
  const close = () => {
    if (current === null) return
    while (current.lines.length > 0 && current.lines.at(-1)!.trim() === "") current.lines.pop()
    blocks.push({ number: current.number, text: current.lines.join("\n") })
    current = null
  }
  for (let index = first; index < lines.length; index += 1) {
    const line = lines[index]!
    const header = parseHeader(line)
    if (header !== null) {
      if (current !== null && lines[index - 1]!.trim() !== "") unseparated.push(header.number)
      close()
      current = { number: header.number, lines: [line] }
    } else if (current !== null) {
      current.lines.push(line)
    } else if (line.trim() !== "" && stray === null) {
      stray = index + 1
    }
  }
  close()
  return { blocks, stray, unseparated }
}

/**
 * The secondary timeline violations of a memory draft: entries other than
 * regular Markdown files, paths over 120 code points, missing
 * descriptions, text other than entries identical to the stored ones,
 * entries no blank line separates, entries out of number order, trimmed
 * entries missing or repeated, and more than 64 files. `entries` are all
 * the session's stored entries, and `render` renders one as stored.
 */
export const memoryViolations = (
  draft: ReadonlyArray<AreaEntry>,
  entries: ReadonlyArray<Entry>,
  render: (entry: Entry) => string,
): ReadonlyArray<string> => {
  const byNumber = new Map(entries.map((entry) => [entry.number, entry]))
  const found = new Map<number, Array<string>>()
  const violations: Array<string> = []
  for (const entry of draft) {
    const path = `memory-draft/${entry.name}`
    if (entry.text === null) {
      violations.push(notMarkdown(path))
      continue
    }
    if (codePoints(entry.name) > ENTRY_FIELD_MAX_LENGTH) violations.push(`\`${path}\`: the path is over ${ENTRY_FIELD_MAX_LENGTH} characters.`)
    const described = describedProblem(path, entry.text)
    if (described !== null) violations.push(described)
    const { blocks, stray, unseparated } = parseTimeline(entry.text, frontmatterDescription(entry.text)?.bodyLine ?? 0)
    if (stray !== null) violations.push(`\`${path}\` holds text other than entries, at line ${stray}.`)
    for (const number of unseparated) violations.push(`\`${path}\`: no blank line separates entry #${number} from the entry before it.`)
    let previous = 0
    for (const block of blocks) {
      const stored = byNumber.get(block.number)
      if (stored === undefined || render(stored) !== block.text) {
        violations.push(`\`${path}\`: entry #${block.number} differs from entry #${block.number} as recorded.`)
      }
      if (block.number <= previous) violations.push(`\`${path}\`: entry #${block.number} comes after a later entry.`)
      previous = Math.max(previous, block.number)
      const paths = found.get(block.number) ?? []
      if (!paths.includes(path)) paths.push(path)
      found.set(block.number, paths)
    }
  }
  for (const entry of entries) {
    if (!entry.trimmed) continue
    const paths = found.get(entry.number) ?? []
    if (paths.length === 0) violations.push(`Entry #${entry.number} is in no secondary timeline.`)
    else if (paths.length > 1) violations.push(`Entry #${entry.number} is in \`${paths[0]}\` and \`${paths[1]}\`.`)
  }
  if (draft.length > MEMORY_FILES_MAX) violations.push(overCount(draft.length))
  return violations
}

/** Validates `research/` and `memory-draft/`. */
export const validateFiles = (
  research: ReadonlyArray<AreaEntry>,
  draft: ReadonlyArray<AreaEntry>,
  entries: ReadonlyArray<Entry>,
  render: (entry: Entry) => string,
): Violations => ({
  research: researchViolations(research),
  memory: memoryViolations(draft, entries, render),
  count: draft.length,
})
