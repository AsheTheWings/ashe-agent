import { loadInputsOrExit, processSources } from "../../server/src/inputs/bootstrap.ts"

/** Creates Vite from the development inputs, without dependency environment overrides. */
export const createDevelopmentWebServer = async (root = new URL("..", import.meta.url).pathname) => {
  const sources = processSources()
  const { inputs } = loadInputsOrExit("devWeb", { ...sources, env: { ...sources.env, ASHE_AGENT_PROFILE: "development" } })
  const platform = new Set(["PATH", "HOME", "TMPDIR", "LANG", "TZ", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"])
  for (const name of Object.keys(process.env)) if (!platform.has(name)) delete process.env[name]
  const { createServer } = await import("vite")
  return createServer({
    root,
    define: { __ASHE_AGENT_DEV_SERVER_URL__: JSON.stringify(inputs.devWebServerUrl) },
    server: { host: "127.0.0.1", allowedHosts: [...inputs.devWebAllowedHosts], strictPort: true },
  })
}

if (import.meta.main) {
  const server = await createDevelopmentWebServer()
  await server.listen()
  server.printUrls()
}
