import { extname } from "node:path"
import { formatFromBytes, toMarkdownBytes, type Format } from "@firecrawl/anydoc"

/** The largest document `file_read` converts. */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024

/** The format anydoc detects in a file's bytes, or CSV by its extension; null for anything else. */
export const documentFormat = (path: string, bytes: Uint8Array): Format | null => {
  const detected = formatFromBytes(bytes)
  if (detected !== null) return detected
  return extname(path).toLowerCase() === ".csv" ? ("csv" as Format) : null
}

export type Conversion = { readonly ok: true; readonly markdown: string } | { readonly ok: false; readonly reason: string }

/**
 * A document as Markdown, converted in this process. anydoc's hosted OCR
 * is never requested, so a document never leaves the host; a failure
 * names anydoc's error code, and for `needsOcr` the pages that need OCR.
 */
export const convertDocument = async (bytes: Uint8Array, format: Format): Promise<Conversion> => {
  try {
    return { ok: true, markdown: await toMarkdownBytes(bytes, format, { ocr: "reject" }) }
  } catch (error) {
    const failure = error as { code?: string; pages?: ReadonlyArray<number>; pageCount?: number; message?: string }
    const code = failure.code ?? "unknown"
    if (code === "needsOcr" && failure.pages !== undefined) {
      return {
        ok: false,
        reason: `needsOcr: pages ${failure.pages.join(", ")} of ${failure.pageCount ?? "?"} are scanned or image-only and need OCR, which file_read does not do.`,
      }
    }
    return { ok: false, reason: `${code}: ${failure.message ?? "the conversion failed"}` }
  }
}
