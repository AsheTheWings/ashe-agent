/** The configured development endpoint, or the page's own server in a static build. */
export const serverEndpoint = (origin: string, developmentUrl: string | null): string => {
  if (developmentUrl !== null) return new URL(developmentUrl).href
  const url = new URL("/v1/ws", origin)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.href
}
