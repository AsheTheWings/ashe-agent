import { PDFiumLibrary } from "@hyzyla/pdfium/inline"
import { PNG } from "pngjs"
import { ConversionError, readWorkerRequest, verifyWorkerLimits } from "./conversion.ts"

interface Request {
  readonly pdf: string
  readonly window: { readonly offset: number; readonly limit: number }
  readonly geometry: { readonly dpi: number; readonly maxLongEdge: number; readonly maxPixelsPerPage: number }
}

const finitePositive = (value: number) => Number.isFinite(value) && value > 0

/** Converts one bounded PDF window after proving the worker's OS limits. */
export const runConversionWorker = async () => {
  const expected = process.argv[3]
  if (expected === undefined) throw new ConversionError("unsupported", "conversion worker received no expected limits")
  const limits = JSON.parse(expected) as { dataBytes?: unknown; stackBytes?: unknown; cpuSeconds?: unknown }
  if (
    typeof limits.dataBytes !== "number" ||
    typeof limits.stackBytes !== "number" ||
    typeof limits.cpuSeconds !== "number"
  ) {
    throw new ConversionError("invalid", "conversion worker expected limits are malformed")
  }
  await verifyWorkerLimits({
    dataBytes: limits.dataBytes,
    stackBytes: limits.stackBytes,
    cpuSeconds: limits.cpuSeconds,
  })
  const request = JSON.parse(await readWorkerRequest()) as Request
  if (!Number.isInteger(request.window.offset) || request.window.offset < 1 || !Number.isInteger(request.window.limit) || request.window.limit < 1) {
    throw new ConversionError("invalid", "invalid PDF page window")
  }
  if (!Number.isInteger(request.geometry.dpi) || !finitePositive(request.geometry.dpi) || !finitePositive(request.geometry.maxLongEdge) || !finitePositive(request.geometry.maxPixelsPerPage)) {
    throw new ConversionError("invalid", "invalid PDF geometry limits")
  }
  const bytes = Buffer.from(request.pdf, "base64")
  const library = await PDFiumLibrary.init({ disableBase64Warning: true })
  try {
    const document = await library.loadDocument(bytes)
    try {
      const total = document.getPageCount()
      if (request.window.offset > total) {
        throw new ConversionError("invalid", `pageOffset ${request.window.offset} is past the PDF's ${total} pages`)
      }
      const end = Math.min(total, request.window.offset + request.window.limit - 1)
      const pages: Array<{ page: number; total: number; png: string; width: number; height: number }> = []
      const text: Array<string> = []
      for (let number = request.window.offset; number <= end; number += 1) {
        const page = document.getPage(number - 1)
        try {
          const extracted = page.getText().trim()
          if (extracted !== "") text.push(`## Page ${number}\n\n${extracted}`)
          const original = page.getOriginalSize()
          if (!finitePositive(original.originalWidth) || !finitePositive(original.originalHeight)) {
            throw new ConversionError("invalid", `PDF page ${number} has invalid geometry`)
          }
          const pixelScale = Math.sqrt(request.geometry.maxPixelsPerPage / (original.originalWidth * original.originalHeight))
          const scale = Math.min(
            request.geometry.dpi / 72,
            request.geometry.maxLongEdge / original.originalWidth,
            request.geometry.maxLongEdge / original.originalHeight,
            pixelScale,
          )
          if (!finitePositive(scale)) throw new ConversionError("invalid", `PDF page ${number} cannot fit its geometry limits`)
          const image = await page.render({
            scale,
            colorSpace: "RGBA",
            transparent: false,
            renderFormFields: false,
            render: async ({ data, width, height }) => {
              if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > request.geometry.maxLongEdge || height > request.geometry.maxLongEdge || width * height > request.geometry.maxPixelsPerPage) {
                throw new ConversionError("invalid", `PDF page ${number} exceeded its raster limits`)
              }
              return PNG.sync.write({ width, height, data: Buffer.from(data) })
            },
          })
          pages.push({ page: number, total, png: Buffer.from(image.data).toString("base64"), width: image.width, height: image.height })
        } finally {
          page.close()
        }
      }
      process.stdout.write(JSON.stringify({ total, text: text.join("\n\n"), pages }))
    } finally {
      document.destroy()
    }
  } finally {
    library.destroy()
  }
}
