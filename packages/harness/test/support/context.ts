import { Schema } from "effect"
import type { ModelCall, ModelPort } from "../../src/agent/model.ts"
import { builtinTool, type Tool } from "../../src/agent/tools.ts"
import { COMPACTION_PROMPT, HANDOFF_PROMPT, RESEARCH_PROMPT } from "../../src/context/auxiliary.ts"
import { sha256 } from "../../src/sessions/files.ts"
import { AgentHarness, configuredModel, say, testTools, type FakeModel, type Reply } from "./agent.ts"

export type AuxiliaryKind = "compaction" | "research" | "handoff"

const kindOf = (call: ModelCall): AuxiliaryKind | null =>
  call.instructions === COMPACTION_PROMPT.text
    ? "compaction"
    : call.instructions === RESEARCH_PROMPT.text
      ? "research"
      : call.instructions === HANDOFF_PROMPT.text
        ? "handoff"
        : null

/**
 * A model port that answers turn model calls from `main`, the harness's
 * fake model, and auxiliary calls from a scripted queue per task, each a
 * default reply when its queue is empty, recording every auxiliary call.
 */
export class RoutedModel implements ModelPort {
  readonly auxiliary: Array<{ readonly kind: AuxiliaryKind; readonly call: ModelCall }> = []
  private readonly queues: Record<AuxiliaryKind, Array<Reply>> = { compaction: [], research: [], handoff: [] }
  private readonly defaults: Record<AuxiliaryKind, Reply> = {
    compaction: say("Requests:\n- the user's request"),
    research: say("The file gained a finding."),
    handoff: say("Task:\n- the task"),
  }

  constructor(readonly main: FakeModel) {}

  /** Answers the calls of `kind` that no queued reply answers with `reply`. */
  otherwise(kind: AuxiliaryKind, reply: Reply) {
    this.defaults[kind] = reply
  }

  /** Queues replies for the next auxiliary calls of `kind`. */
  next(kind: AuxiliaryKind, ...replies: ReadonlyArray<Reply>) {
    this.queues[kind].push(...replies)
  }

  calls(kind: AuxiliaryKind) {
    return this.auxiliary.filter((entry) => entry.kind === kind).map((entry) => entry.call)
  }

  readonly stream = (call: ModelCall, signal: AbortSignal) => {
    const kind = kindOf(call)
    if (kind === null) return this.main.stream(call, signal)
    this.auxiliary.push({ kind, call })
    return (this.queues[kind].shift() ?? this.defaults[kind])(call, signal)
  }
}

/** A model whose checkpoint window is `size` tokens, so a context turn starts once an estimate passes `size` less 40,000. */
export const windowModel = (id: string, size: number, efforts: ReadonlyArray<string> = []) =>
  configuredModel(id, { contextLimit: 400_000, efforts, settings: { checkpointWindowSize: size } })

/** Text of `tokens` estimated tokens. */
export const filler = (tokens: number, letter = "x") => letter.repeat(tokens * 4)

/** `blob` returns about `tokens` estimated tokens of text from small arguments. */
export const blobTool: Tool = builtinTool({
  name: "blob",
  permission: null,
  description: "Returns text of the given size.",
  args: Schema.Struct({ tokens: Schema.Number, letter: Schema.optionalKey(Schema.String) }),
  run: async ({ tokens, letter }) => ({ outcome: "success", content: filler(tokens, letter ?? "b") }),
})

/** A harness whose model port routes auxiliary calls to a `RoutedModel`, with the test tools and `blob`. */
export const contextHarness = (options: ConstructorParameters<typeof AgentHarness>[0] = {}) => {
  let routed: RoutedModel | undefined
  const h = new AgentHarness({
    tools: [...testTools(), blobTool],
    ...options,
    port: { stream: (call, signal) => routed!.stream(call, signal) },
  })
  routed = new RoutedModel(h.model)
  return { h, aux: routed }
}

/** Publishes `files` as the session's next memory generation, as a context turn's passed validation does. */
export const publishMemory = (h: AgentHarness, id: string, files: Record<string, string>) => {
  const state = h.hub.store.files
  const stored = Object.entries(files).map(([name, text]) => {
    const data = Buffer.from(text)
    return { name, data, sha256: sha256(data) }
  })
  const next = state.generations(id).memory + 1
  const recorded = h.files.writeGeneration(id, next, stored)
  h.db.transaction(() => {
    state.putFiles(stored)
    state.recordGeneration(id, next, recorded, Date.now())
  })()
  h.files.pointMemory(id, next)
  h.files.removeOtherGenerations(id, next)
  return next
}
