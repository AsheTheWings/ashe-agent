import { estimateStructured, estimateText, type ModelInputManifest, type SemanticEntry, type SemanticPageEntry } from "@ashe-agent/protocol"

export type SessionToolStat = {
  readonly name: string
  readonly count: number
  readonly failed: number
}

export type SessionKindTokenStat = {
  readonly kind: SemanticEntry["kind"]
  readonly label: string
  readonly count: number
  readonly tokens: number
}

export type SessionStats = {
  readonly totalMessages: number
  readonly userMessages: number
  readonly agentMessages: number
  readonly toolCalls: number
  readonly failedTools: number
  readonly thoughts: number
  readonly mostUsedTool: SessionToolStat | null
  readonly topTools: ReadonlyArray<SessionToolStat>
  readonly estimatedTokens: number
  readonly byKind: ReadonlyArray<SessionKindTokenStat>
}

const KIND_LABELS: Record<SemanticEntry["kind"], string> = {
  system: "System",
  developer: "Developer",
  user: "User messages",
  agent: "Agent messages",
  "agent-thought": "Thoughts",
  "agent-tool": "Tool calls",
}

const estimateEntryTokens = (item: SemanticPageEntry): number => {
  if (item.body !== null) return Math.ceil(item.body.byteLength / 4)
  const { entry } = item
  switch (entry.kind) {
    case "system":
      return estimateText(entry.content.text)
    case "developer":
      return entry.components.reduce((sum, component) => sum + estimateText(`${component.heading}\n${component.text}`), 0)
    case "user":
      return entry.parts.reduce((sum, part) => sum + (part.kind === "text" ? estimateText(part.text) : 1_500), 0)
    case "agent":
      return entry.parts.reduce((sum, part) => sum + (part.kind === "text" ? estimateText(part.text) : 1_500), 0)
    case "agent-thought":
      return estimateText(entry.text)
    case "agent-tool": {
      const argTokens = estimateStructured(entry.tool.arguments.value)
      const resultTokens =
        entry.tool.result?.content.reduce(
          (sum, part) => sum + (part.kind === "text" ? estimateText(part.text) : 1_500),
          0,
        ) ?? 0
      return argTokens + resultTokens
    }
  }
}

/** Whether a semantic entry carries visible content to display in Session or count as an agent message. */
export const hasVisibleSemanticContent = (entry: SemanticEntry): boolean => {
  if (entry.kind === "agent") {
    return entry.parts.some((part) => part.kind !== "text" || part.text.trim() !== "")
  }
  if (entry.kind === "agent-thought") {
    return entry.text.trim() !== ""
  }
  return true
}

/** Computes high-value session insights from canonical semantic entries. */
export const computeSessionStats = (entries: ReadonlyArray<SemanticPageEntry>): SessionStats => {
  let userMessages = 0
  let agentMessages = 0
  let toolCalls = 0
  let failedTools = 0
  let thoughts = 0
  let estimatedTokens = 0

  const toolsMap = new Map<string, { count: number; failed: number }>()
  const kindMap = new Map<SemanticEntry["kind"], { count: number; tokens: number }>()

  for (const item of entries) {
    const { entry } = item
    if (item.body === null && !hasVisibleSemanticContent(entry)) continue
    const tokens = estimateEntryTokens(item)
    estimatedTokens += tokens

    const kindBucket = kindMap.get(entry.kind) ?? { count: 0, tokens: 0 }
    kindBucket.count += 1
    kindBucket.tokens += tokens
    kindMap.set(entry.kind, kindBucket)

    if (entry.kind === "user") userMessages += 1
    else if (entry.kind === "agent") agentMessages += 1
    else if (entry.kind === "agent-thought") thoughts += 1
    else if (entry.kind === "agent-tool") {
      toolCalls += 1
      const failed =
        entry.tool.outcome === "failed" ||
        entry.tool.outcome === "declined" ||
        entry.tool.outcome === "canceled" ||
        entry.tool.outcome === "interrupted"
      if (failed) failedTools += 1
      const toolBucket = toolsMap.get(entry.tool.name) ?? { count: 0, failed: 0 }
      toolBucket.count += 1
      if (failed) toolBucket.failed += 1
      toolsMap.set(entry.tool.name, toolBucket)
    }
  }

  const topTools: Array<SessionToolStat> = [...toolsMap.entries()]
    .map(([name, bucket]) => ({ name, count: bucket.count, failed: bucket.failed }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const byKind: Array<SessionKindTokenStat> = [...kindMap.entries()]
    .map(([kind, bucket]) => ({
      kind,
      label: KIND_LABELS[kind],
      count: bucket.count,
      tokens: bucket.tokens,
    }))
    .sort((a, b) => b.tokens - a.tokens)

  return {
    totalMessages: userMessages + agentMessages,
    userMessages,
    agentMessages,
    toolCalls,
    failedTools,
    thoughts,
    mostUsedTool: topTools[0] ?? null,
    topTools,
    estimatedTokens,
    byKind,
  }
}

export type CheckpointSegmentCategory =
  | "system"
  | "developer"
  | "tools"
  | "user"
  | "assistant"
  | "tool-results"
  | "other"

export type CheckpointSegment = {
  readonly id: string
  readonly label: string
  readonly category: CheckpointSegmentCategory
  readonly detail?: string
  readonly tokens: number
  readonly share: number
  readonly colorToken: string
}

export type ProviderUsageEntry = {
  readonly modelCallId: string
  readonly metrics: ReadonlyArray<{ readonly key: string; readonly value: string; readonly numeric: number | null }>
}

export type CheckpointStats = {
  readonly boundaryId: string
  readonly windowPosition: number
  readonly committedAt: number
  readonly contributionCount: number
  readonly knownSubtotal: number
  readonly coverage: "complete" | "partial"
  readonly unavailableCount: number
  readonly segments: ReadonlyArray<CheckpointSegment>
  readonly providerInputTokens: number | null
  readonly providerOutputTokens: number | null
  readonly providerTotalTokens: number | null
  readonly providerUsage: ReadonlyArray<ProviderUsageEntry>
}

const CATEGORY_COLORS: Record<CheckpointSegmentCategory, string> = {
  developer: "var(--chart-1)",
  system: "var(--chart-2)",
  tools: "var(--chart-3)",
  user: "var(--chart-4)",
  assistant: "var(--chart-5)",
  "tool-results": "var(--primary)",
  other: "var(--muted-foreground)",
}

const parseUsageEntries = (
  usage: ReadonlyArray<{ readonly modelCallId: string; readonly providerUsage: unknown }>,
): {
  readonly input: number | null
  readonly output: number | null
  readonly total: number | null
  readonly entries: ReadonlyArray<ProviderUsageEntry>
} => {
  let input: number | null = null
  let output: number | null = null
  let total: number | null = null
  const entries: Array<ProviderUsageEntry> = []

  for (const row of usage) {
    const raw = row.providerUsage
    const metrics: Array<{ readonly key: string; readonly value: string; readonly numeric: number | null }> = []
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      metrics.push({ key: "raw", value: JSON.stringify(raw), numeric: null })
    } else {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const numeric = typeof value === "number" && Number.isFinite(value) ? value : null
        metrics.push({
          key,
          value: numeric !== null ? numeric.toLocaleString() : typeof value === "string" ? value : JSON.stringify(value),
          numeric,
        })
        if (numeric !== null) {
          const normalized = key.toLowerCase().replaceAll("_", "")
          if (normalized === "inputtokens" || normalized === "prompttokens") input = (input ?? 0) + numeric
          else if (normalized === "outputtokens" || normalized === "completiontokens") output = (output ?? 0) + numeric
          else if (normalized === "totaltokens") total = (total ?? 0) + numeric
        }
      }
    }
    entries.push({ modelCallId: row.modelCallId, metrics })
  }

  return { input, output, total, entries }
}

/**
 * Computes semantic token distribution for a Checkpoint boundary, splitting
 * developer contributions down to individual SemanticDeveloperComponents when
 * the session's canonical semantic entries are available.
 */
export const computeCheckpointStats = (
  manifest: ModelInputManifest | null,
  semanticEntries: ReadonlyArray<SemanticPageEntry>,
  usage: ReadonlyArray<{ readonly modelCallId: string; readonly providerUsage: unknown }>,
): CheckpointStats | null => {
  if (manifest === null) return null

  const entryById = new Map<string, SemanticEntry>(semanticEntries.map((item) => [item.entry.id, item.entry]))
  const measurementByPosition = new Map<number, number>()
  const measurementByRep = new Map<string, number>()

  for (const item of manifest.measurement.contributions) {
    if (item.tokens === null) continue
    measurementByPosition.set(item.contributionPosition, (measurementByPosition.get(item.contributionPosition) ?? 0) + item.tokens)
    for (const repId of item.representationIds) {
      if (!measurementByRep.has(repId)) measurementByRep.set(repId, item.tokens)
    }
  }

  // Exclude provider-wire duplicate wrappers when semantic contributions are present.
  const hasSemantic = manifest.contributions.some(
    (contribution) => contribution.kind === "tool-definition" || contribution.kind === "placeholder" || contribution.transformation !== "provider-message",
  )
  const activeContributions = hasSemantic
    ? manifest.contributions.filter(
        (contribution) => contribution.kind === "tool-definition" || contribution.kind === "placeholder" || contribution.transformation !== "provider-message",
      )
    : manifest.contributions

  const buckets = new Map<
    string,
    { label: string; category: CheckpointSegmentCategory; detail?: string; tokens: number }
  >()
  const addBucket = (
    id: string,
    label: string,
    category: CheckpointSegmentCategory,
    tokens: number,
    detail?: string,
  ) => {
    if (tokens <= 0) return
    const existing = buckets.get(id)
    if (existing !== undefined) {
      existing.tokens += tokens
      return
    }
    buckets.set(id, { label, category, ...(detail === undefined ? {} : { detail }), tokens })
  }

  let toolDefCount = 0

  for (const contribution of activeContributions) {
    if (contribution.kind === "placeholder") continue

    if (contribution.kind === "tool-definition") {
      toolDefCount += 1
      const tokens =
        measurementByRep.get(contribution.rendered.representationId) ??
        measurementByPosition.get(contribution.position) ??
        estimateStructured({
          name: contribution.name,
          description: contribution.description,
          parameters: contribution.parameters,
        })
      addBucket("tool-definitions", "Tool definitions", "tools", tokens)
      continue
    }

    const fallbackTokens =
      measurementByPosition.get(contribution.position) ??
      Math.max(1, Math.ceil(contribution.rendered.byteLength / 4))

    if (contribution.kind === "instruction" || contribution.transformation === "harness-system") {
      addBucket("system", "System & harness", "system", fallbackTokens)
      continue
    }

    const entryIds =
      contribution.sourceEntryIds.length > 0
        ? contribution.sourceEntryIds
        : contribution.sourceEntryId !== null
          ? [contribution.sourceEntryId]
          : []
    const matchedEntries = entryIds
      .map((id) => entryById.get(id))
      .filter((entry): entry is SemanticEntry => entry !== undefined)

    const developerEntries = matchedEntries.filter(
      (entry): entry is Extract<SemanticEntry, { kind: "developer" }> => entry.kind === "developer",
    )

    if (contribution.transformation === "developer-block" || developerEntries.length > 0) {
      const components = developerEntries.flatMap((entry) => entry.components)
      if (components.length > 0) {
        for (const component of components) {
          const title = component.heading.trim() !== "" ? component.heading.trim() : component.type
          const tokens = Math.max(1, estimateText(`${component.heading}\n${component.text}`))
          addBucket(`dev:${component.type}:${title.toLowerCase()}`, title, "developer", tokens, `developer · ${component.type}`)
        }
      } else {
        addBucket("dev:generic", "Developer context", "developer", fallbackTokens, "developer")
      }
      continue
    }

    if (
      contribution.transformation === "user-block" ||
      contribution.transformation === "attachment-original" ||
      matchedEntries.some((entry) => entry.kind === "user")
    ) {
      addBucket("user", "User messages", "user", fallbackTokens)
      continue
    }

    if (
      contribution.transformation === "tool-result" ||
      contribution.transformation === "model-projection" ||
      contribution.transformation === "context-result-cleared" ||
      matchedEntries.some((entry) => entry.kind === "agent-tool")
    ) {
      addBucket("tool-results", "Tool results", "tool-results", fallbackTokens)
      continue
    }

    if (
      contribution.transformation === "native-replay" ||
      contribution.transformation === "foreign-transcript" ||
      matchedEntries.some((entry) => entry.kind === "agent" || entry.kind === "agent-thought")
    ) {
      const measuredTokens =
        measurementByRep.get(contribution.representation.representationId) ??
        measurementByRep.get(contribution.rendered.representationId) ??
        measurementByPosition.get(contribution.position)
      addBucket("assistant", "Assistant", "assistant", measuredTokens ?? fallbackTokens)
      continue
    }

    addBucket("other", "Messages & other", "other", fallbackTokens)
  }

  const toolDefBucket = buckets.get("tool-definitions")
  if (toolDefBucket !== undefined && toolDefCount > 0) {
    toolDefBucket.detail = `${toolDefCount} offered tool${toolDefCount === 1 ? "" : "s"}`
  }

  const totalSegmentTokens = [...buckets.values()].reduce((sum, item) => sum + item.tokens, 0)
  const segments: Array<CheckpointSegment> = [...buckets.entries()]
    .map(([id, item]) => ({
      id,
      label: item.label,
      category: item.category,
      ...(item.detail === undefined ? {} : { detail: item.detail }),
      tokens: item.tokens,
      share: totalSegmentTokens > 0 ? item.tokens / totalSegmentTokens : 0,
      colorToken: CATEGORY_COLORS[item.category],
    }))
    .sort((a, b) => b.tokens - a.tokens)

  const parsedUsage = parseUsageEntries(usage)

  return {
    boundaryId: manifest.id,
    windowPosition: manifest.windowPosition,
    committedAt: manifest.committedAt,
    contributionCount: activeContributions.length,
    knownSubtotal: manifest.measurement.knownSubtotal,
    coverage: manifest.measurement.coverage,
    unavailableCount: manifest.measurement.unavailable.length,
    segments,
    providerInputTokens: parsedUsage.input,
    providerOutputTokens: parsedUsage.output,
    providerTotalTokens: parsedUsage.total,
    providerUsage: parsedUsage.entries,
  }
}
