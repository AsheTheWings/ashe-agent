/** The tags only the server opens and closes in the model's context. */
const reservedTag = /<(\/?)(system|developer|user)>/g

/**
 * Escapes every literal `<system>`, `<developer>`, and `<user>` tag, open
 * or closing, as `&lt;…>`, so text placed in a block cannot open or close one.
 */
export const escapeTags = (text: string) => text.replace(reservedTag, "&lt;$1$2>")

/** `text` as a block of `tag`, which the caller has escaped. */
export const block = (tag: string, text: string, attributes = "") => `<${tag}${attributes}>\n${text}\n</${tag}>`

const fence = /^ {0,3}(`{3,}|~{3,})/
const atxHeading = /^( {0,3})(#{1,6})(?=[ \t]|$)/
const setextUnderline = /^ {0,3}(=+|-+)[ \t]*$/
const notParagraph = /^ {0,3}(#|>|[-+*][ \t]|\d+[.)][ \t]|`{3}|~{3})|^( {4}|\t)/

/**
 * Lowers every Markdown heading of `markdown` by one level, so it sits below
 * the section heading it is placed under, and changes nothing else. ATX
 * headings gain a `#`, up to six; a setext level-one underline becomes
 * level two, and a setext level-two heading becomes an ATX level three.
 * Lines inside fenced code are left as they are.
 */
export const lowerHeadings = (markdown: string): string => {
  const lines = markdown.split("\n")
  const out: Array<string> = []
  let open: string | null = null
  for (const line of lines) {
    const fenceMatch = fence.exec(line)
    if (open !== null) {
      if (fenceMatch !== null && fenceMatch[1]![0] === open[0] && fenceMatch[1]!.length >= open.length) open = null
      out.push(line)
      continue
    }
    if (fenceMatch !== null) {
      open = fenceMatch[1]!
      out.push(line)
      continue
    }
    const atx = atxHeading.exec(line)
    if (atx !== null) {
      out.push(atx[2]!.length < 6 ? `${atx[1]}#${line.slice(atx[1]!.length)}` : line)
      continue
    }
    const underline = setextUnderline.exec(line)
    const previous = out.at(-1)
    if (underline !== null && previous !== undefined && previous.trim() !== "" && !notParagraph.test(previous)) {
      if (underline[1]![0] === "=") out.push(line.replace(/=/g, "-"))
      else out[out.length - 1] = `### ${previous.trim()}`
      continue
    }
    out.push(line)
  }
  return out.join("\n")
}

/** A user message as a `<user>` block. */
export const userBlock = (text: string) => block("user", escapeTags(text))

/** The fixed `instructions` of every model call, so no provider substitutes its own. */
export const REQUEST_INSTRUCTIONS = "You're a helpful assistant."
