import { describe, expect, test } from "bun:test"
import { Redacted, Result } from "effect"
import { readProtectedFile, readProviderKeys, resolveInputs, type FileRead, type Sources } from "../src/inputs/resolve.ts"

const dirs = { home: "/home/owner", configHome: "/home/owner/.config", stateHome: "/home/owner/.local/state", cacheHome: "/home/owner/.cache" }
const configPath = "/home/owner/.config/ashe-agent/config.json"
const githubKeyPath = "/run/ashe-agent/github-key"
const keyPath = "/run/ashe-agent/exa-api-key"

const modelEntry = { limit: { context: 400_000 }, capabilities: { input: ["text", "image"] } }
const providers = { main: { baseURL: "http://127.0.0.1:8317/v1", apiKeyFile: "/run/ashe-agent/main-key", models: { "model-a": modelEntry } } }

/** Sources with the given process input and files, everything else absent. */
const sources = (
  env: Record<string, string>,
  files: Record<string, FileRead> = {},
): Sources => ({
  env: { ASHE_AGENT_PROFILE: "development", ...env },
  dirs,
  readFile: (path) => files[path] ?? (path === githubKeyPath ? { kind: "ok", text: "synthetic-github-secret", mode: 0o600 } : { kind: "absent" }),
})

const protectedFile = (text: string, mode = 0o600): FileRead => ({ kind: "ok", text, mode })
const configFile = (config: unknown): FileRead => ({ kind: "ok", text: JSON.stringify(config), mode: 0o644 })

/** Process input that satisfies every input serve requires in development, with the Exa key file as a protected input. */
const serveEnv = {
  ASHE_AGENT_GITHUB_CLIENT_ID: "test",
  ASHE_AGENT_GITHUB_CLIENT_SECRET_FILE: githubKeyPath,
  ASHE_AGENT_GITHUB_CALLBACK_URL: "http://127.0.0.1/callback",
  ASHE_AGENT_GITHUB_OWNER_ID: "42",
  ASHE_AGENT_EXA_API_KEY_FILE: keyPath,
  ASHE_AGENT_PROVIDERS: JSON.stringify(providers),
  ASHE_AGENT_DEFAULT_MODEL: "main/model-a",
}
const serveFiles = { [keyPath]: protectedFile("sk-test-key") }

const issuesOf = (resolution: ReturnType<typeof resolveInputs>) =>
  resolution.ok ? [] : resolution.issues.map((issue) => issue.input)

describe("profiles", () => {
  test("an absent profile is required", () => {
    const resolution = resolveInputs("token", { ...sources({}), env: {} })
    expect(resolution.ok).toBe(false)
    expect(issuesOf(resolution)).toEqual(["ASHE_AGENT_PROFILE"])
  })

  test("an unknown profile is refused", () => {
    const resolution = resolveInputs("token", sources({ ASHE_AGENT_PROFILE: "staging" }))
    expect(issuesOf(resolution)).toEqual(["ASHE_AGENT_PROFILE"])
  })

  test("an invalid profile still reports invalid process input", () => {
    const resolution = resolveInputs("token", sources({ ASHE_AGENT_PROFILE: "staging", ASHE_AGENT_STATE_DIR: "state" }))
    expect(issuesOf(resolution).sort()).toEqual(["ASHE_AGENT_PROFILE", "ASHE_AGENT_STATE_DIR"])
  })

  test("an invalid profile still reports the config file and protected files", () => {
    const env = { ...serveEnv, ASHE_AGENT_PROFILE: "staging" }
    const files = { [configPath]: { kind: "ok", text: "{", mode: 0o644 } as const }
    expect(issuesOf(resolveInputs("serve", sources(env, files))).sort()).toEqual([
      "ASHE_AGENT_CONFIG_FILE",
      "ASHE_AGENT_EXA_API_KEY_FILE",
      "ASHE_AGENT_PROFILE",
    ])
  })
})

describe("defaults", () => {
  test("development defaults apply and paths follow the XDG directories", () => {
    const resolution = resolveInputs("serve", sources(serveEnv, serveFiles))
    if (!resolution.ok) throw new Error(JSON.stringify(resolution.issues))
    expect(resolution.inputs.listenHost).toBe("127.0.0.1")
    expect(resolution.inputs.listenPort).toBe(7420)
    expect(resolution.inputs.stateDir).toBe("/home/owner/.local/state/ashe-agent")
    expect(resolution.inputs.instructionsFile).toBe("/home/owner/.config/ashe-agent/AGENTS.md")
    expect(resolution.inputs.titlesDir).toBe("/home/owner/.config/ashe-agent/titles")
    expect(resolution.inputs.scratchRoot).toBe("/home/owner/.cache/ashe-agent/scratch")
    expect(resolution.inputs.userTimeZone).toBe("UTC")
    expect(resolution.inputs.agents).toEqual({})
    expect(resolution.inputs.defaultAgent).toBeNull()
    expect(resolution.inputs.auxiliaryModels).toEqual({})
    expect(resolution.inputs.skillRoots).toEqual([
      "/home/owner/.agents/skills",
      "/home/owner/.config/ashe-agent/skills",
    ])
    expect(resolution.inputs.shellYieldMs).toBe(10_000)
  })

  test("an input without a production default is required in production", () => {
    const resolution = resolveInputs("serve", sources({ ...serveEnv, ASHE_AGENT_PROFILE: "production" }, serveFiles))
    expect(issuesOf(resolution).sort()).toEqual([
      "ASHE_AGENT_DEPLOYMENT_ENVIRONMENT",
      "ASHE_AGENT_LISTEN_PORT",
      "ASHE_AGENT_ORIGINS",
      "ASHE_AGENT_USER_TIME_ZONE",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
    ])
  })

  test("a process validates only the inputs it uses", () => {
    const resolution = resolveInputs("token", sources({ ASHE_AGENT_PROVIDERS: "not json" }))
    expect(resolution.ok).toBe(true)
  })
})

describe("protected inputs", () => {
  test("a missing protected file is refused", () => {
    const resolution = resolveInputs("serve", sources(serveEnv))
    expect(issuesOf(resolution)).toEqual(["ASHE_AGENT_EXA_API_KEY_FILE"])
  })

  test("an optional protected input without its file input is null", () => {
    const { ASHE_AGENT_EXA_API_KEY_FILE: _, ...withoutKey } = serveEnv
    const resolution = resolveInputs("serve", sources(withoutKey))
    expect(resolution.ok && resolution.inputs.exaApiKey).toBeNull()
  })

  test("the value is the file's bytes, redacted", () => {
    const resolution = resolveInputs("serve", sources(serveEnv, { [keyPath]: protectedFile("sk-test-key\n") }))
    if (!resolution.ok) throw new Error(JSON.stringify(resolution.issues))
    const key = resolution.inputs.exaApiKey
    expect(key).not.toBeNull()
    expect(Redacted.value(key!)).toBe("sk-test-key\n")
    expect(String(key)).not.toContain("sk-test-key")
  })

  test("a file its group or others can read is refused", () => {
    const resolution = resolveInputs("serve", sources(serveEnv, { [keyPath]: protectedFile("sk-test-key", 0o640) }))
    expect(issuesOf(resolution)).toEqual(["ASHE_AGENT_EXA_API_KEY_FILE"])
  })

  test("a protected input in the config file is refused", () => {
    const resolution = resolveInputs(
      "serve",
      sources(serveEnv, { ...serveFiles, [configPath]: configFile({ exaApiKey: "sk-test-key" }) }),
    )
    expect(issuesOf(resolution)).toEqual(['config file key "exaApiKey"'])
  })

  test("issues never carry a protected value", () => {
    const resolution = resolveInputs(
      "serve",
      sources(serveEnv, { ...serveFiles, [configPath]: configFile({ exaApiKey: "sk-secret-marker" }) }),
    )
    expect(JSON.stringify(resolution)).not.toContain("sk-secret-marker")
  })

  test("the protected file reader refuses files others can access and redacts the rest", () => {
    const files: Record<string, FileRead> = {
      "/run/a": protectedFile("token-a", 0o600),
      "/run/b": protectedFile("token-b", 0o604),
      "/run/c": { kind: "error", message: "EACCES" },
    }
    const reader = (path: string) => files[path] ?? ({ kind: "absent" } as const)
    const ok = readProtectedFile("/run/a", reader)
    expect(Result.isSuccess(ok) && Redacted.value(ok.success)).toBe("token-a")
    expect(Result.isFailure(readProtectedFile("/run/b", reader))).toBe(true)
    expect(Result.isFailure(readProtectedFile("/run/c", reader))).toBe(true)
    expect(Result.isFailure(readProtectedFile("/run/none", reader))).toBe(true)
  })
})

describe("malformed values", () => {
  test("a non-numeric port is refused", () => {
    const resolution = resolveInputs("serve", sources({ ...serveEnv, ASHE_AGENT_LISTEN_PORT: "http" }, serveFiles))
    expect(issuesOf(resolution)).toEqual(["ASHE_AGENT_LISTEN_PORT"])
  })

  test("a port out of range is refused", () => {
    const resolution = resolveInputs("serve", sources({ ...serveEnv, ASHE_AGENT_LISTEN_PORT: "70000" }, serveFiles))
    expect(issuesOf(resolution)).toEqual(["ASHE_AGENT_LISTEN_PORT"])
  })

  test("port 0 is accepted", () => {
    const resolution = resolveInputs("serve", sources({ ...serveEnv, ASHE_AGENT_LISTEN_PORT: "0" }, serveFiles))
    expect(resolution.ok && resolution.inputs.listenPort).toBe(0)
  })

  test("a relative path is refused", () => {
    const resolution = resolveInputs("token", sources({ ASHE_AGENT_STATE_DIR: "state" }))
    expect(issuesOf(resolution)).toEqual(["ASHE_AGENT_STATE_DIR"])
  })

  test("an origin with a path is refused", () => {
    const env = { ...serveEnv, ASHE_AGENT_ORIGINS: JSON.stringify(["https://example.com/app"]) }
    expect(issuesOf(resolveInputs("serve", sources(env, serveFiles)))).toEqual(["ASHE_AGENT_ORIGINS"])
  })

  test("an unknown config file key is refused", () => {
    const resolution = resolveInputs("token", sources({}, { [configPath]: configFile({ listenPrt: 1 }) }))
    expect(issuesOf(resolution)).toEqual(['config file key "listenPrt"'])
  })

  test("a config file that is not JSON is refused", () => {
    const resolution = resolveInputs("token", sources({}, { [configPath]: { kind: "ok", text: "{", mode: 0o644 } }))
    expect(issuesOf(resolution)).toEqual(["ASHE_AGENT_CONFIG_FILE"])
  })

  test("an unreadable config file is refused", () => {
    const resolution = resolveInputs("token", sources({}, { [configPath]: { kind: "error", message: "EACCES" } }))
    expect(issuesOf(resolution)).toEqual(["ASHE_AGENT_CONFIG_FILE"])
  })

  test("an MCP server named after a reserved namespace is refused", () => {
    const env = {
      ...serveEnv,
      ASHE_AGENT_MCP_SERVERS: JSON.stringify({ shell: { type: "stdio", command: "server" } }),
    }
    expect(issuesOf(resolveInputs("serve", sources(env, serveFiles)))).toEqual(["ASHE_AGENT_MCP_SERVERS"])
  })

  test("an MCP server accepts only codemode false", () => {
    const withCodemode = (codemode: boolean) =>
      resolveInputs("serve", sources({
        ...serveEnv,
        ASHE_AGENT_MCP_SERVERS: JSON.stringify({ docs: { type: "http", url: "https://mcp.example.com", codemode } }),
      }, serveFiles))
    expect(withCodemode(false).ok).toBe(true)
    expect(issuesOf(withCodemode(true))).toEqual(["ASHE_AGENT_MCP_SERVERS"])
  })

  test("every problem is reported at once", () => {
    const env = { ...serveEnv, ASHE_AGENT_LISTEN_PORT: "-1", ASHE_AGENT_SHELL_YIELD_MS: "10" }
    expect(issuesOf(resolveInputs("serve", sources(env, serveFiles))).sort()).toEqual([
      "ASHE_AGENT_LISTEN_PORT",
      "ASHE_AGENT_SHELL_YIELD_MS",
    ])
  })
})

describe("boundaries", () => {
  const accepts = (env: Record<string, string>) => resolveInputs("serve", sources({ ...serveEnv, ...env }, serveFiles)).ok

  test("the listen port spans 0 to 65535", () => {
    expect(accepts({ ASHE_AGENT_LISTEN_PORT: "65535" })).toBe(true)
    expect(accepts({ ASHE_AGENT_LISTEN_PORT: "65536" })).toBe(false)
    expect(accepts({ ASHE_AGENT_LISTEN_PORT: "-1" })).toBe(false)
    expect(accepts({ ASHE_AGENT_LISTEN_PORT: "7420.5" })).toBe(false)
  })

  test("the shell yield spans 250 to 30000 ms", () => {
    expect(accepts({ ASHE_AGENT_SHELL_YIELD_MS: "250" })).toBe(true)
    expect(accepts({ ASHE_AGENT_SHELL_YIELD_MS: "249" })).toBe(false)
    expect(accepts({ ASHE_AGENT_SHELL_YIELD_MS: "30000" })).toBe(true)
    expect(accepts({ ASHE_AGENT_SHELL_YIELD_MS: "30001" })).toBe(false)
  })

  test("counts and budgets are at least 1", () => {
    expect(accepts({ ASHE_AGENT_SHELL_MAX_PROCESSES: "1" })).toBe(true)
    expect(accepts({ ASHE_AGENT_SHELL_MAX_PROCESSES: "0" })).toBe(false)
    expect(accepts({ ASHE_AGENT_SHELL_MAX_OUTPUT_TOKENS: "1" })).toBe(true)
    expect(accepts({ ASHE_AGENT_SHELL_MAX_OUTPUT_TOKENS: "0" })).toBe(false)
    expect(accepts({ ASHE_AGENT_CODE_MODE_LIMITS: JSON.stringify({ toolCalls: 1 }) })).toBe(true)
    expect(accepts({ ASHE_AGENT_CODE_MODE_LIMITS: JSON.stringify({ toolCalls: 0 }) })).toBe(false)
  })
})

describe("layer precedence", () => {
  test("the config file overrides a default and process input overrides the config file", () => {
    const files = { ...serveFiles, [configPath]: configFile({ listenHost: "0.0.0.0", listenPort: 9000 }) }
    const resolution = resolveInputs("serve", sources({ ...serveEnv, ASHE_AGENT_LISTEN_PORT: "9100" }, files))
    if (!resolution.ok) throw new Error(JSON.stringify(resolution.issues))
    expect(resolution.inputs.listenHost).toBe("0.0.0.0")
    expect(resolution.inputs.listenPort).toBe(9100)
  })

  test("process input names another config file", () => {
    const other = "/etc/ashe-agent/config.json"
    const files = { ...serveFiles, [other]: configFile({ listenHost: "10.0.0.1" }) }
    const resolution = resolveInputs("serve", sources({ ...serveEnv, ASHE_AGENT_CONFIG_FILE: other }, files))
    expect(resolution.ok && resolution.inputs.listenHost).toBe("10.0.0.1")
  })

  test("the config file cannot name another config file", () => {
    const resolution = resolveInputs("token", sources({}, { [configPath]: configFile({ configFile: "/tmp/x.json" }) }))
    expect(issuesOf(resolution)).toEqual(['config file key "configFile"'])
  })

  test("providers set by the config file are used when process input sets none", () => {
    const { ASHE_AGENT_PROVIDERS: _, ...env } = serveEnv
    const files = { ...serveFiles, [configPath]: configFile({ providers }) }
    const resolution = resolveInputs("serve", sources(env, files))
    expect(resolution.ok && (resolution.inputs.providers as unknown)).toEqual(providers)
  })
})

describe("GitHub and development web inputs", () => {
  test("the OAuth app and owner have no defaults in either profile", () => {
    for (const profile of ["development", "production"]) {
      const env = { ...serveEnv, ASHE_AGENT_PROFILE: profile } as Record<string, string>
      for (const name of ["ASHE_AGENT_GITHUB_CLIENT_ID", "ASHE_AGENT_GITHUB_CLIENT_SECRET_FILE", "ASHE_AGENT_GITHUB_CALLBACK_URL", "ASHE_AGENT_GITHUB_OWNER_ID"]) delete env[name]
      const issues = issuesOf(resolveInputs("serve", sources(env, serveFiles)))
      for (const name of ["ASHE_AGENT_GITHUB_CLIENT_ID", "ASHE_AGENT_GITHUB_CLIENT_SECRET_FILE", "ASHE_AGENT_GITHUB_CALLBACK_URL", "ASHE_AGENT_GITHUB_OWNER_ID"]) expect(issues).toContain(name)
    }
  })

  test("callback URLs and owner IDs are validated, and a missing GitHub secret fails closed", () => {
    for (const owner of ["0", "-1", "1.5", '"42"']) {
      expect(issuesOf(resolveInputs("serve", sources({ ...serveEnv, ASHE_AGENT_GITHUB_OWNER_ID: owner }, serveFiles)))).toContain("ASHE_AGENT_GITHUB_OWNER_ID")
    }
    expect(issuesOf(resolveInputs("serve", sources({ ...serveEnv, ASHE_AGENT_GITHUB_CALLBACK_URL: "/relative" }, serveFiles)))).toContain("ASHE_AGENT_GITHUB_CALLBACK_URL")
    expect(issuesOf(resolveInputs("serve", sources(serveEnv, { ...serveFiles, [githubKeyPath]: { kind: "absent" } })))).toEqual(["ASHE_AGENT_GITHUB_CLIENT_SECRET_FILE"])
  })

  test("devWeb resolves only its own inputs and uses an empty allowed-host list by default", () => {
    const defaults = resolveInputs("devWeb", sources({}))
    expect(defaults.ok && defaults.inputs.devWebAllowedHosts).toEqual([])
    expect(defaults.ok && defaults.inputs.devWebServerUrl).toBe("ws://127.0.0.1:7420/v1/ws")
    const configured = resolveInputs("devWeb", sources({ ASHE_AGENT_DEV_WEB_ALLOWED_HOSTS: '["dev.example"]' }))
    expect(configured.ok && configured.inputs.devWebAllowedHosts).toEqual(["dev.example"])
    expect(resolveInputs("token", sources({ ASHE_AGENT_DEV_WEB_ALLOWED_HOSTS: "invalid" })).ok).toBe(true)
  })

  test("the development endpoint accepts WebSocket URLs and refuses malformed or credential-bearing URLs", () => {
    for (const url of ["ws://api.example:7420/v1/ws", "wss://api.example/v1/ws"]) {
      const resolved = resolveInputs("devWeb", sources({ ASHE_AGENT_DEV_WEB_SERVER_URL: url }))
      expect(resolved.ok && resolved.inputs.devWebServerUrl).toBe(url)
    }
    for (const url of ["", "/v1/ws", "https://api.example/v1/ws", "ws://", "ws://user:secret@api.example/v1/ws", "ws://api.example/v1/ws#fragment", "ws://api.example/v1/ws#"]) {
      expect(issuesOf(resolveInputs("devWeb", sources({ ASHE_AGENT_DEV_WEB_SERVER_URL: url })))).toContain("ASHE_AGENT_DEV_WEB_SERVER_URL")
    }
    expect(resolveInputs("token", sources({ ASHE_AGENT_DEV_WEB_SERVER_URL: "invalid" })).ok).toBe(true)
  })
})
