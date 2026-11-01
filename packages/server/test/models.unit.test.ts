import { describe, expect, test } from "bun:test"
import { displayTitle, parseTitleFile } from "../src/agents/titles.ts"
import { WORKING_MARGIN } from "../src/context/constants.ts"
import { resolveInputs, type FileRead, type Sources } from "../src/inputs/resolve.ts"
import { isTitle, type Providers } from "../src/inputs/shapes.ts"
import { callSettings, checkpointWindowSize, configuredModels, workingMargin, type ConfiguredModel } from "../src/models/registry.ts"
import { compileRules, whollyDenied } from "../src/permissions/rules.ts"

const dirs = { home: "/home/owner", configHome: "/home/owner/.config", stateHome: "/home/owner/.local/state", cacheHome: "/home/owner/.cache" }

const entry = (fields: Record<string, unknown> = {}) => ({ limit: { context: 400_000 }, capabilities: { input: ["text"] }, ...fields })

const reasoning = entry({
  capabilities: { input: ["text"], temperature: false, reasoning: { efforts: ["low", "medium", "high"] } },
  reasoningEffort: "medium",
})
const sampling = entry({ capabilities: { input: ["text", "image"], temperature: true }, temperature: 0.7 })

const config = (overrides: Record<string, unknown> = {}) => ({
  providers: { main: { baseURL: "https://api.example.com/v1", apiKeyFile: "/run/key", models: { thinker: reasoning, sampler: sampling } } },
  defaultModel: "main/thinker",
  githubClientId: "test", githubClientSecretFile: "/run/key", githubCallbackUrl: "http://127.0.0.1/callback", githubOwnerId: 42,
  ...overrides,
})

/** Resolves serve's inputs with `config` as the config file. */
const resolve = (overrides: Record<string, unknown> = {}) => {
  const files: Record<string, FileRead> = { "/run/key": { kind: "ok", text: "synthetic", mode: 0o600 }, "/home/owner/.config/ashe-agent/config.json": { kind: "ok", text: JSON.stringify(config(overrides)), mode: 0o600 } }
  const sources: Sources = { env: { ASHE_AGENT_PROFILE: "development" }, dirs, readFile: (path) => files[path] ?? { kind: "absent" } }
  return resolveInputs("serve", sources)
}

const problems = (overrides: Record<string, unknown> = {}) => {
  const resolution = resolve(overrides)
  return resolution.ok ? [] : resolution.issues.map((issue) => `${issue.input}: ${issue.problem}`)
}

const models = (providers: unknown = config().providers) => new Map(configuredModels(providers as Providers).map((model) => [model.id, model]))
const thinker = models().get("main/thinker")!
const sampler = models().get("main/sampler")!

describe("providers and model ids", () => {
  test("models are named <provider>/<model> with their capabilities and settings", () => {
    expect(thinker).toEqual({
      id: "main/thinker",
      provider: "main",
      upstream: "thinker",
      name: "main/thinker",
      contextLimit: 400_000,
      imageInput: false,
      temperatureCapable: false,
      efforts: ["low", "medium", "high"],
      settings: { reasoningEffort: "medium" },
    })
    expect(sampler).toMatchObject({ imageInput: true, temperatureCapable: true, efforts: [], settings: { temperature: 0.7 } })
    const nested = models({ main: { ...config().providers.main, models: { "org/deep": entry({ name: "Deep" }) } } as never })
    expect(nested.get("main/org/deep")).toMatchObject({ provider: "main", upstream: "org/deep", name: "Deep" })
    expect(resolve().ok).toBe(true)
  })

  test("a provider id holding / and a malformed default model id are refused", () => {
    expect(problems({ providers: { "a/b": config().providers.main } }).join("\n")).toContain('the key "a/b" must be a non-empty provider id that does not hold /')
    expect(problems({ defaultModel: "thinker" }).join("\n")).toContain("must be a <provider>/<model> id")
  })

  test("every named model must be registered, and at least one must be", () => {
    expect(problems({ defaultModel: "main/other" })).toEqual(['ASHE_AGENT_DEFAULT_MODEL: names "main/other", which no provider registers'])
    expect(problems({ auxiliaryModels: { research: "other/x" } })).toEqual([
      'ASHE_AGENT_AUXILIARY_MODELS: research names "other/x", which no provider registers',
    ])
    expect(problems({ agents: { helper: { model: "main/other" } } })).toEqual([
      'ASHE_AGENT_AGENTS: the agent helper starts with "main/other", which no provider registers',
    ])
    expect(problems({ providers: { main: { ...config().providers.main, models: {} } } })).toEqual(["ASHE_AGENT_PROVIDERS: must register at least one model"])
  })

  test("a model entry and an agent override refuse any other field", () => {
    expect(problems({ providers: { main: { ...config().providers.main, models: { thinker: { ...reasoning, cost: 1 } } } } })).toHaveLength(1)
    expect(problems({ agents: { helper: { models: { "main/thinker": { limit: { context: 1 } } } } } })).toHaveLength(1)
    expect(problems({ agents: { helper: { mode: "primary" } } })).toHaveLength(1)
  })
})

describe("settings and capabilities", () => {
  test("an effort the model does not list and a temperature without the capability are refused", () => {
    const withThinker = (fields: Record<string, unknown>) => ({ providers: { main: { ...config().providers.main, models: { thinker: { ...reasoning, ...fields } } } } })
    expect(problems(withThinker({ reasoningEffort: "extreme" }))).toEqual([
      'ASHE_AGENT_PROVIDERS: the model main/thinker sets the reasoning effort "extreme", which main/thinker does not list',
    ])
    expect(problems(withThinker({ temperature: 0.5 }))).toEqual(["ASHE_AGENT_PROVIDERS: the model main/thinker sets a temperature, which main/thinker does not accept"])
    expect(problems({ agents: { helper: { models: { "main/thinker": { temperature: 1 } } } } })).toEqual([
      "ASHE_AGENT_AGENTS: the agent helper sets a temperature, which main/thinker does not accept",
    ])
    expect(problems({ agents: { helper: { models: { "main/sampler": { reasoningEffort: "low" } } } } })).toEqual([
      'ASHE_AGENT_AGENTS: the agent helper sets the reasoning effort "low", which main/sampler does not list',
    ])
    expect(problems({ agents: { helper: { models: { "main/thinker": { reasoningEffort: "high" }, "main/sampler": { temperature: 0 } } } } })).toEqual([])
  })

  test("a temperature spans 0 to 2", () => {
    const withSampler = (temperature: number) => ({ providers: { main: { ...config().providers.main, models: { thinker: reasoning, sampler: { ...sampling, temperature } } } } })
    expect(problems(withSampler(0))).toEqual([])
    expect(problems(withSampler(2))).toEqual([])
    expect(problems(withSampler(2.01))).toHaveLength(1)
    expect(problems(withSampler(-0.1))).toHaveLength(1)
  })

  test("the reasoning effort resolves from the turn's selection to the agent's override to the model entry", () => {
    expect(callSettings(thinker, { reasoningEffort: "high" }, "low").reasoning).toEqual({ effort: "low", summary: "auto" })
    expect(callSettings(thinker, { reasoningEffort: "high" }, null).reasoning).toEqual({ effort: "high", summary: "auto" })
    expect(callSettings(thinker, undefined, null).reasoning).toEqual({ effort: "medium", summary: "auto" })
    // A selection the model no longer lists falls through to the next source.
    expect(callSettings(thinker, undefined, "extreme").reasoning).toEqual({ effort: "medium", summary: "auto" })
  })

  test("the reasoning field carries the summary with and without an effort and is omitted without efforts", () => {
    const bare: ConfiguredModel = { ...thinker, settings: {} }
    expect(callSettings(bare, undefined, null)).toEqual({ reasoning: { summary: "auto" } })
    expect(callSettings(sampler, { reasoningEffort: "low" }, "high")).toEqual({ temperature: 0.7 })
  })

  test("the temperature resolves from the agent's override to the model entry and is sent only with the capability", () => {
    expect(callSettings(sampler, { temperature: 0.2 }, null).temperature).toBe(0.2)
    expect(callSettings(sampler, undefined, null).temperature).toBe(0.7)
    expect(callSettings({ ...sampler, settings: {} }, undefined, null).temperature).toBeUndefined()
    // A recorded override for a model that does not accept a temperature is not sent.
    expect(callSettings(thinker, { temperature: 0.9 }, null)).not.toHaveProperty("temperature")
  })
})

describe("checkpoint window sizes and the working margin", () => {
  test("the size is the agent's override, else the entry's setting, else the context limit capped at 480,000", () => {
    const large: ConfiguredModel = { ...thinker, contextLimit: 1_000_000, settings: {} }
    expect(checkpointWindowSize(large, undefined)).toBe(480_000)
    expect(checkpointWindowSize({ ...thinker, settings: {} }, undefined)).toBe(400_000)
    expect(checkpointWindowSize({ ...large, settings: { checkpointWindowSize: 600_000 } }, undefined)).toBe(600_000)
    expect(checkpointWindowSize({ ...large, settings: { checkpointWindowSize: 600_000 } }, { checkpointWindowSize: 300_000 })).toBe(300_000)
  })

  test("a checkpointWindowSize above limit.context is refused", () => {
    expect(problems({ providers: { main: { ...config().providers.main, models: { thinker: { ...reasoning, checkpointWindowSize: 400_001 } } } } })).toEqual([
      "ASHE_AGENT_PROVIDERS: the model main/thinker sets a checkpointWindowSize of 400001, above the 400000 tokens of main/thinker's limit.context",
    ])
    expect(problems({ agents: { helper: { models: { "main/thinker": { checkpointWindowSize: 400_000 } } } } })).toEqual([])
  })

  test("the working margin is the size less the seed, tool definitions, and reserve allowances", () => {
    expect(workingMargin(250_000)).toBe(WORKING_MARGIN)
    expect(workingMargin(480_000)).toBe(330_000)
  })

  test("each model and agent pair, the implicit agent included, needs the working margin", () => {
    const small = (context: number) => ({ providers: { main: { ...config().providers.main, models: { thinker: { ...reasoning, limit: { context } } } } } })
    expect(problems(small(250_000))).toEqual([])
    expect(problems(small(249_999))).toEqual([
      "ASHE_AGENT_PROVIDERS: the model main/thinker with the implicit agent leaves a working margin of 99999 tokens, below 100000",
    ])
    expect(problems({ agents: { helper: { models: { "main/sampler": { checkpointWindowSize: 249_000 } } } } })).toEqual([
      "ASHE_AGENT_AGENTS: the model main/sampler with the agent helper leaves a working margin of 99000 tokens, below 100000",
    ])
  })
})

describe("agents and titles", () => {
  test("titles are 1 to 64 characters of lowercase words joined by single dashes", () => {
    for (const key of ["a", "code-reviewer", "r2-d2", "x".repeat(64)]) expect(isTitle(key)).toBe(true)
    for (const key of ["", "Code", "code_reviewer", "-a", "a-", "a--b", "a b", "x".repeat(65)]) expect(isTitle(key)).toBe(false)
    expect(problems({ agents: { "Code-Reviewer": {} } }).join("\n")).toContain('the key "Code-Reviewer" must be a title')
    expect(problems({ agents: { "code-reviewer": {} } })).toEqual([])
  })

  test("a display title is the key in capitalized words", () => {
    expect(displayTitle("code-reviewer")).toBe("Code Reviewer")
    expect(displayTitle("r2-d2")).toBe("R2 D2")
    expect(displayTitle("writer")).toBe("Writer")
  })

  test("the default agent must be an agent key", () => {
    expect(problems({ defaultAgent: "helper" })).toEqual(['ASHE_AGENT_DEFAULT_AGENT: names "helper", which is no agent'])
    expect(problems({ defaultAgent: "helper", agents: { helper: {} } })).toEqual([])
  })

  test("a title file holds only a description of 1 to 1,024 characters, then its user instructions", () => {
    expect(parseTitleFile("---\ndescription: Reviews code\n---\nReview carefully.\n")).toEqual({ ok: true, description: "Reviews code", body: "Review carefully.\n" })
    expect(parseTitleFile(`---\ndescription: ${"d".repeat(1_024)}\n---\n`)).toMatchObject({ ok: true })
    expect(parseTitleFile(`---\ndescription: ${"d".repeat(1_025)}\n---\n`)).toEqual({ ok: false, reason: "its description is longer than 1024 characters" })
    expect(parseTitleFile("---\ndescription: d\nmodel: x\n---\n")).toEqual({ ok: false, reason: 'its frontmatter holds "model", not only description' })
    expect(parseTitleFile("No frontmatter.")).toEqual({ ok: false, reason: "its frontmatter has no description" })
    expect(parseTitleFile("---\ndescription: ''\n---\n")).toEqual({ ok: false, reason: "its frontmatter has no description" })
  })

  test("the time zone must be an IANA zone name", () => {
    expect(problems({ userTimeZone: "Europe/Berlin" })).toEqual([])
    expect(problems({ userTimeZone: "Mars/Olympus" })).toHaveLength(1)
  })
})

describe("wholly denied tools", () => {
  const rules = (permission: Parameters<typeof compileRules>[0]) => compileRules(permission, "/home/owner")

  test("a tool is wholly denied when the last rule matching its name denies the pattern *", () => {
    expect(whollyDenied(rules({ shell: "deny" }), "shell")).toBe(true)
    expect(whollyDenied(rules({ "docs_*": "deny" }), "docs_search")).toBe(true)
    expect(whollyDenied(rules("deny"), "execute")).toBe(true)
    expect(whollyDenied(rules({ shell: { "rm *": "deny" } }), "shell")).toBe(false)
    expect(whollyDenied(rules({ shell: "ask" }), "shell")).toBe(false)
    expect(whollyDenied(rules({}), "shell")).toBe(false)
  })

  test("a later narrower allow keeps the tool offered", () => {
    expect(whollyDenied(rules({ shell: { "*": "deny", "git status": "allow" } }), "shell")).toBe(false)
    expect(whollyDenied([...rules("deny"), { permission: "web", pattern: "https://docs.example.com/*", action: "allow" }], "web")).toBe(false)
    expect(whollyDenied([...rules({ shell: { "git *": "allow" } }), ...rules({ "*": "deny" })], "shell")).toBe(true)
  })
})
