/** A minimal Exa REST client: one key, one attempt, and failures that never carry the key or the request. */

const TIMEOUT_MS = 120_000

/** A failed Exa request: its HTTP status and Exa's error tag when Exa answered, else the transport failure class. */
export class ExaError extends Error {
  constructor(
    readonly status: number | null,
    readonly tag: string | null,
  ) {
    super(status === null ? (tag ?? "unavailable") : `HTTP ${status}${tag === null ? "" : ` (${tag})`}`)
    this.name = "ExaError"
  }
}

export interface ExaClient {
  post(path: "/search" | "/contents", payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Posts JSON to Exa at `baseUrl` with the key as `x-api-key`, timing out after 120 s. */
export const exaClient = (baseUrl: string, apiKey: string, fetchFn: typeof fetch = fetch): ExaClient => ({
  async post(path, payload, signal) {
    let response: Response
    let text: string
    // The timeout and the failure classes cover the whole exchange, the response body included.
    try {
      response = await fetchFn(`${baseUrl.replace(/\/+$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      })
      text = await response.text()
    } catch (error) {
      if (signal.aborted) throw error
      throw new ExaError(null, error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "unavailable")
    }
    const body = record(parse(text))
    if (!response.ok) throw new ExaError(response.status, typeof body?.tag === "string" ? body.tag : null)
    if (body === null) throw new ExaError(response.status, "non-JSON response")
    return body
  },
})

export const records = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.map(record).filter((entry) => entry !== null) : []

export const errorTag = (value: unknown) => record(record(value)?.error)?.tag
