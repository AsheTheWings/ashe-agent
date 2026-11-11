import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff"
import type { ToolSpec } from "../agent/model.ts"
import type { Catalogs, UserInstructions } from "../sessions/hub.ts"
import {
  codeModeCatalogChanged,
  codeModeCatalogSeed,
  instructionsDiff,
  instructionsSwitched,
  sessionFacts,
  skillCatalogChanged,
  skillCatalogSeed,
  userInstructionsSeed,
  type Component,
  type Dates,
  type InstructionsState,
} from "./components.ts"
import {
  CHECKPOINT_ALLOWANCE,
  CODE_MODE_CATALOG_ALLOWANCE,
  estimateTokens,
  HARNESS_INSTRUCTIONS_ALLOWANCE,
  SESSION_FACTS_ALLOWANCE,
  SKILL_CATALOG_ALLOWANCE,
  TOOL_DEFINITIONS_ALLOWANCE,
  USER_INSTRUCTIONS_ALLOWANCE,
} from "./constants.ts"

/** Something over its allowance: what it is, its estimated tokens, and the allowance. */
export interface AllowanceIssue {
  readonly what: string
  readonly tokens: number
  readonly allowance: number
}

export const allowanceMessage = (issue: AllowanceIssue) =>
  `${issue.what} is ${issue.tokens} estimated tokens, over its allowance of ${issue.allowance}`

/** Each allowanced component's name, what errors call it, and its allowance. */
const allowances: Readonly<Record<string, { readonly what: string; readonly allowance: number }>> = {
  user_instructions: { what: "the user instructions component", allowance: USER_INSTRUCTIONS_ALLOWANCE },
  skill_catalog: { what: "the skill catalog component", allowance: SKILL_CATALOG_ALLOWANCE },
  skill_catalog_changed: { what: "the skill catalog", allowance: SKILL_CATALOG_ALLOWANCE },
  code_mode_catalog: { what: "the code mode catalog component", allowance: CODE_MODE_CATALOG_ALLOWANCE },
  code_mode_catalog_changed: { what: "the code mode catalog", allowance: CODE_MODE_CATALOG_ALLOWANCE },
  session_facts: { what: "the session facts component", allowance: SESSION_FACTS_ALLOWANCE },
  session_checkpoint: { what: "the session checkpoint component", allowance: CHECKPOINT_ALLOWANCE },
}

/** The allowance issue of a component over its allowance, if it has one. */
export const componentIssue = (component: Component): AllowanceIssue | null => {
  const limit = allowances[component.name]
  if (limit === undefined) return null
  const tokens = estimateTokens(component.text)
  return tokens > limit.allowance ? { what: limit.what, tokens, allowance: limit.allowance } : null
}

/** The allowance issue of tool definitions over their allowance, if they are. */
export const toolDefinitionsIssue = (specs: ReadonlyArray<ToolSpec>): AllowanceIssue | null => {
  const tokens = estimateTokens(JSON.stringify(specs))
  return tokens > TOOL_DEFINITIONS_ALLOWANCE ? { what: "the tool definitions", tokens, allowance: TOOL_DEFINITIONS_ALLOWANCE } : null
}

/** The state a version of the user instructions establishes. */
export const instructionsState = (instructions: UserInstructions | null): InstructionsState =>
  instructions === null
    ? { kind: "none" }
    : { kind: instructions.source, path: instructions.path, sha256: instructions.sha256, metadata: instructions.metadata }

/** What a checkpoint window's seed is rendered from. */
export interface SeedSources {
  readonly harness: string
  readonly instructions: UserInstructions | null
  /** The display title of the session's agent, or null for the implicit agent. */
  readonly title: string | null
  readonly catalogs: Catalogs
  readonly sessionId: string
  readonly dates: Dates
  readonly scratchGeneration: number
  readonly memoryRestoreGeneration: number
  /** The session checkpoint, which every checkpoint window after the first ends its seed with. */
  readonly checkpoint?: Component
  /** The tool definitions to check, or null when the construction leaves them to each model call. */
  readonly tools: ReadonlyArray<ToolSpec> | null
}

/**
 * The seed components of a checkpoint window in their order, the session
 * checkpoint last when given, or the first issue of the harness
 * instructions, a component, or the tool definitions over its allowance.
 */
export const renderSeed = (
  sources: SeedSources,
): { readonly ok: true; readonly components: ReadonlyArray<Component> } | { readonly ok: false; readonly issue: AllowanceIssue } => {
  const harnessTokens = estimateTokens(sources.harness)
  if (harnessTokens > HARNESS_INSTRUCTIONS_ALLOWANCE) {
    return { ok: false, issue: { what: "the harness instructions", tokens: harnessTokens, allowance: HARNESS_INSTRUCTIONS_ALLOWANCE } }
  }
  const instructions = sources.instructions
  const components = [
    instructions === null ? null : userInstructionsSeed(instructions.text, sources.title, instructionsState(instructions)),
    skillCatalogSeed(sources.catalogs.skills),
    codeModeCatalogSeed(sources.catalogs.codeMode),
    sessionFacts({
      sessionId: sources.sessionId,
      title: sources.title,
      dates: sources.dates,
      scratchGeneration: sources.scratchGeneration,
      memoryRestoreGeneration: sources.memoryRestoreGeneration,
    }),
    sources.checkpoint ?? null,
  ].filter((component) => component !== null)
  for (const component of components) {
    const issue = componentIssue(component)
    if (issue !== null) return { ok: false, issue }
  }
  const tools = sources.tools === null ? null : toolDefinitionsIssue(sources.tools)
  if (tools !== null) return { ok: false, issue: tools }
  return { ok: true, components }
}

/** A built checkpoint window's estimated size: its harness instructions and seed components. */
export const seedTokens = (harness: string, components: ReadonlyArray<Component>) =>
  components.reduce((sum, component) => sum + estimateTokens(component.text), estimateTokens(harness))

/** One unified diff from `before` to `after` of the file at `path`. */
export const unifiedDiff = (path: string, before: string, after: string) =>
  createTwoFilesPatch(path, path, before, after, undefined, undefined, { headerOptions: FILE_HEADERS_ONLY })

/**
 * The user instructions state component for `current`, read now, against
 * the `known` state, whose text is `knownText`: none when they agree, a
 * diff within one source, empty content included, and the new source with
 * its full content on a switch of source.
 */
export const instructionsChange = (
  known: InstructionsState,
  knownText: string | null,
  current: UserInstructions | null,
  title: string | null,
): Component | null => {
  const state = instructionsState(current)
  if (state.kind === "none") return known.kind === "none" ? null : instructionsSwitched("", state, known, title)
  // Empty instructions have no seed component, so where none are known they agree with none.
  if (known.kind === "none" && current!.text.trim() === "") return null
  if (known.kind === state.kind && known.path === state.path) {
    if (known.sha256 === state.sha256) return null
    if (knownText !== null) return instructionsDiff(unifiedDiff(state.path, knownText, current!.text), state)
  }
  return instructionsSwitched(current!.text, state, known, title)
}

/** The catalog state components for catalogs that differ from those known, with any that is over its allowance. */
export const catalogChanges = (
  known: Catalogs,
  current: Catalogs,
): { readonly components: ReadonlyArray<Component>; readonly issues: ReadonlyArray<AllowanceIssue> } => {
  const candidates = [
    known.skills === current.skills ? null : skillCatalogChanged(current.skills),
    known.codeMode === current.codeMode ? null : codeModeCatalogChanged(current.codeMode),
  ].filter((component) => component !== null)
  const components: Array<Component> = []
  const issues: Array<AllowanceIssue> = []
  for (const component of candidates) {
    const issue = componentIssue(component)
    if (issue === null) components.push(component)
    else issues.push(issue)
  }
  return { components, issues }
}
