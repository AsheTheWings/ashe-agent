const SESSION_ROUTE_PREFIX = "/sessions/"

/** Builds the canonical browser pathname for one session id. */
export const sessionPath = (sessionId: string): string =>
  `${SESSION_ROUTE_PREFIX}${encodeURIComponent(sessionId)}`

/** Extracts the decoded session id from `/sessions/<id>`, or null when the pathname is not a valid session route. */
export const parseSessionPath = (pathname: string): string | null => {
  if (!pathname.startsWith(SESSION_ROUTE_PREFIX)) return null
  const raw = pathname.slice(SESSION_ROUTE_PREFIX.length).replace(/\/$/, "")
  if (raw === "" || raw.includes("/")) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  const trimmed = decoded.trim()
  if (trimmed === "" || trimmed === "." || trimmed === ".." || decoded.includes("/") || decoded.includes("\\")) {
    return null
  }
  return decoded
}

/** True when a GET/HEAD pathname should serve the SPA shell (`index.html`). */
export const isSpaRoute = (pathname: string): boolean =>
  pathname === "/" || parseSessionPath(pathname) !== null
