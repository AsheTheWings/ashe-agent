import {
  estimateStructured,
  estimateText,
  type ContextMediaProjection,
  type ModelCallContext,
  type SemanticEntry,
  type SemanticPageEntry,
} from "@ashe-agent/protocol"

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
  "system-message": "System",
  "developer-message": "Developer",
  "user-message": "User messages",
  "agent-message": "Agent messages",
  "agent-thought": "Thoughts",
  "agent-tool": "Tool calls",
}

const estimateEntryTokens = (item: SemanticPageEntry): number => {
  if (item.body !== null) return Math.ceil(item.body.byteLength / 4)
  const { entry } = item
  switch (entry.kind) {
    case "system-message":
      return estimateText(entry.content.text)
    case "developer-message":
      return entry.components.reduce((sum, component) => sum + estimateText(`${component.heading}\n${component.text}`), 0)
    case "user-message":
      return entry.parts.reduce((sum, part) => sum + (part.kind === "text" ? estimateText(part.text) : 1_500), 0)
    case "agent-message":
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
  if (entry.kind === "agent-message") {
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

    if (entry.kind === "user-message") userMessages += 1
    else if (entry.kind === "agent-message") agentMessages += 1
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

export type CheckpointGroupId = "harness" | "agent-output" | "user-messages"

export type CheckpointSegment = {
  readonly id: string
  readonly groupId: CheckpointGroupId
  readonly label: string
  readonly detail?: string
  readonly tokens: number
  readonly share: number
  readonly colorToken: string
}

export type CheckpointGroup = {
  readonly id: CheckpointGroupId
  readonly label: string
  readonly detail?: string
  readonly tokens: number
  readonly share: number
  readonly colorToken: string
  readonly subgroups: ReadonlyArray<CheckpointSegment>
}

export type ProviderUsageEntry = {
  readonly modelCallId: string
  readonly metrics: ReadonlyArray<{ readonly key: string; readonly value: string; readonly numeric: number | null }>
}

export type CheckpointStats = {
  readonly contextId: string
  readonly windowPosition: number
  readonly committedAt: number
  readonly itemCount: number
  readonly toolCount: number
  readonly windowTokens: number
  readonly windowTokensSource: "provider" | "estimated"
  readonly knownSubtotal: number
  readonly coverage: "complete" | "partial"
  readonly unavailableCount: number
  readonly groups: ReadonlyArray<CheckpointGroup>
  readonly segments: ReadonlyArray<CheckpointSegment>
  readonly providerInputTokens: number | null
  readonly providerOutputTokens: number | null
  readonly providerTotalTokens: number | null
  readonly providerReasoningTokens: number | null
  readonly providerCachedTokens: number | null
  readonly providerUsage: ReadonlyArray<ProviderUsageEntry>
}

const COLORS = {
  system: "var(--chart-2)",
  toolDefinitions: "var(--chart-3)",
  developer: "var(--chart-1)",
  toolResults: "var(--primary)",
  agentOutput: "var(--chart-5)",
  userMessages: "var(--chart-4)",
} as const

type ParsedCallUsage = {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalTokens: number | null
  readonly reasoningTokens: number | null
  readonly cachedTokens: number | null
  readonly entry: ProviderUsageEntry
}

const parseUsageRow = (row: { readonly modelCallId: string; readonly providerUsage: unknown }): ParsedCallUsage => {
  let inputTokens: number | null = null
  let outputTokens: number | null = null
  let totalTokens: number | null = null
  let reasoningTokens: number | null = null
  let cachedTokens: number | null = null
  const raw = row.providerUsage
  const metrics: Array<{ readonly key: string; readonly value: string; readonly numeric: number | null }> = []
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    metrics.push({ key: "raw", value: JSON.stringify(raw), numeric: null })
  } else {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === null) continue
      const numeric = typeof value === "number" && Number.isFinite(value) ? value : null
      metrics.push({
        key,
        value: numeric !== null ? numeric.toLocaleString() : typeof value === "string" ? value : JSON.stringify(value),
        numeric,
      })
      if (numeric !== null) {
        const normalized = key.toLowerCase().replaceAll("_", "")
        if (normalized === "inputtokens" || normalized === "prompttokens") inputTokens = numeric
        else if (normalized === "outputtokens" || normalized === "completiontokens") outputTokens = numeric
        else if (normalized === "totaltokens") totalTokens = numeric
        else if (normalized === "reasoningtokens") reasoningTokens = numeric
        else if (normalized === "cachedtokens") cachedTokens = numeric
      }
    }
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedTokens,
    entry: { modelCallId: row.modelCallId, metrics },
  }
}

const estimateMediaTokens = (projections: ReadonlyArray<ContextMediaProjection>): number =>
  projections.reduce((sum, projection) => {
    if (projection.kind === "placeholder") return sum + estimateText(projection.reason)
    if (projection.mediaKind === "image") return sum + 1_500
    if (projection.mediaKind === "pdf") return sum + 2_000
    return sum + Math.ceil(projection.byteLength / 4)
  }, 0)

const byteTokens = (bytes: number): number => (bytes > 0 ? Math.max(1, Math.ceil(bytes / 4)) : 0)

/**
 * Computes Checkpoint window size (provider-reported when available) and the
 * estimated 3-group semantic distribution (`Harness`, `Agent output`, `User messages`).
 */
export const computeCheckpointStats = (
  context: ModelCallContext | null,
  semanticEntries: ReadonlyArray<SemanticPageEntry>,
  usage: ReadonlyArray<{ readonly modelCallId: string; readonly providerUsage: unknown }>,
): CheckpointStats | null => {
  if (context === null) return null

  const entryById = new Map<string, SemanticEntry>(semanticEntries.map((item) => [item.entry.id, item.entry]))
  const usageByCallId = new Map<string, ParsedCallUsage>()
  for (const row of usage) usageByCallId.set(row.modelCallId, parseUsageRow(row))

  const currentUsage = usageByCallId.get(context.modelCallId) ?? null

  let systemTokens = 0
  let toolDefTokens = 0
  let developerTokens = 0
  let toolResultTokens = 0
  let visibleAgentTokens = 0
  let userTokens = 0

  const developerLabels = new Set<string>()
  const visibleAgentOutputByCall = new Map<string, number>()
  const opaqueThoughtCallIds = new Set<string>()
  let hasOpaqueReplay = false

  for (const tool of context.tools) {
    toolDefTokens += estimateStructured({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })
  }

  for (const item of context.items) {
    switch (item.kind) {
      case "system-message":
        systemTokens += byteTokens(item.byteLength)
        break
      case "developer-message": {
        developerTokens += byteTokens(item.byteLength)
        if (item.transcript !== null) {
          developerLabels.add(item.transcript.heading || "Transcript")
        } else {
          for (const sourceId of item.sourceEntryIds) {
            const matched = entryById.get(sourceId)
            if (matched?.kind === "developer-message") {
              for (const component of matched.components) {
                developerLabels.add(component.heading.trim() || component.type)
              }
            }
          }
        }
        break
      }
      case "user-message":
        userTokens += byteTokens(item.byteLength) + estimateMediaTokens(item.attachments)
        break
      case "agent-thought":
        if (item.opaque) {
          hasOpaqueReplay = true
          if (item.modelCallId !== null) opaqueThoughtCallIds.add(item.modelCallId)
        } else {
          const tokens = byteTokens(item.byteLength)
          visibleAgentTokens += tokens
          if (item.modelCallId !== null) {
            visibleAgentOutputByCall.set(item.modelCallId, (visibleAgentOutputByCall.get(item.modelCallId) ?? 0) + tokens)
          }
        }
        break
      case "agent-message": {
        const tokens = byteTokens(item.byteLength)
        visibleAgentTokens += tokens
        if (item.modelCallId !== null) {
          visibleAgentOutputByCall.set(item.modelCallId, (visibleAgentOutputByCall.get(item.modelCallId) ?? 0) + tokens)
        }
        break
      }
      case "agent-tool": {
        const inputTokens = byteTokens(item.inputByteLength)
        visibleAgentTokens += inputTokens
        if (item.modelCallId !== null) {
          visibleAgentOutputByCall.set(item.modelCallId, (visibleAgentOutputByCall.get(item.modelCallId) ?? 0) + inputTokens)
        }
        toolResultTokens += byteTokens(item.resultByteLength) + estimateMediaTokens(item.resultMedia)
        break
      }
    }
  }

  const harnessTokens = systemTokens + toolDefTokens + developerTokens + toolResultTokens
  const visibleTotal = harnessTokens + visibleAgentTokens + userTokens

  let opaqueAgentTokens = 0
  if (hasOpaqueReplay && currentUsage !== null && currentUsage.inputTokens !== null) {
    let replayedCap = 0
    for (const callId of opaqueThoughtCallIds) {
      const prior = usageByCallId.get(callId)
      if (prior === undefined) continue
      if (prior.reasoningTokens !== null) {
        replayedCap += prior.reasoningTokens
      } else if (prior.outputTokens !== null) {
        replayedCap += Math.max(0, prior.outputTokens - (visibleAgentOutputByCall.get(callId) ?? 0))
      }
    }
    const gap = Math.max(0, currentUsage.inputTokens - visibleTotal)
    opaqueAgentTokens = Math.min(replayedCap, gap)
  }

  const agentOutputTokens = visibleAgentTokens + opaqueAgentTokens
  const totalEstimated = harnessTokens + agentOutputTokens + userTokens
  const shareOf = (tokens: number) => (totalEstimated > 0 ? tokens / totalEstimated : 0)

  const developerSummary = [...developerLabels].slice(0, 3).join(", ")
  const developerDetail =
    developerLabels.size > 3
      ? `${developerSummary} +${developerLabels.size - 3}`
      : developerSummary || undefined

  const harnessSubgroups: Array<CheckpointSegment> = [
    ...(systemTokens > 0
      ? [{
          id: "harness:system",
          groupId: "harness" as const,
          label: "System message",
          tokens: systemTokens,
          share: shareOf(systemTokens),
          colorToken: COLORS.system,
        }]
      : []),
    ...(toolDefTokens > 0
      ? [{
          id: "harness:tool-definitions",
          groupId: "harness" as const,
          label: "Tool definitions",
          detail: `${context.tools.length} offered tool${context.tools.length === 1 ? "" : "s"}`,
          tokens: toolDefTokens,
          share: shareOf(toolDefTokens),
          colorToken: COLORS.toolDefinitions,
        }]
      : []),
    ...(developerTokens > 0
      ? [{
          id: "harness:developer",
          groupId: "harness" as const,
          label: "Developer messages",
          ...(developerDetail === undefined ? {} : { detail: developerDetail }),
          tokens: developerTokens,
          share: shareOf(developerTokens),
          colorToken: COLORS.developer,
        }]
      : []),
    ...(toolResultTokens > 0
      ? [{
          id: "harness:tool-results",
          groupId: "harness" as const,
          label: "Tool results",
          tokens: toolResultTokens,
          share: shareOf(toolResultTokens),
          colorToken: COLORS.toolResults,
        }]
      : []),
  ]

  const agentDetail =
    opaqueAgentTokens > 0
      ? "includes opaque reasoning"
      : hasOpaqueReplay
        ? "opaque reasoning unmeasured"
        : undefined

  const groups: Array<CheckpointGroup> = [
    ...(harnessTokens > 0
      ? [{
          id: "harness" as const,
          label: "Harness",
          tokens: harnessTokens,
          share: shareOf(harnessTokens),
          colorToken: COLORS.toolDefinitions,
          subgroups: harnessSubgroups,
        }]
      : []),
    ...(agentOutputTokens > 0 || hasOpaqueReplay
      ? [{
          id: "agent-output" as const,
          label: "Agent output",
          ...(agentDetail === undefined ? {} : { detail: agentDetail }),
          tokens: agentOutputTokens,
          share: shareOf(agentOutputTokens),
          colorToken: COLORS.agentOutput,
          subgroups: [],
        }]
      : []),
    ...(userTokens > 0
      ? [{
          id: "user-messages" as const,
          label: "User messages",
          tokens: userTokens,
          share: shareOf(userTokens),
          colorToken: COLORS.userMessages,
          subgroups: [],
        }]
      : []),
  ]

  const segments: Array<CheckpointSegment> = [
    ...harnessSubgroups,
    ...(agentOutputTokens > 0
      ? [{
          id: "agent-output",
          groupId: "agent-output" as const,
          label: "Agent output",
          ...(agentDetail === undefined ? {} : { detail: agentDetail }),
          tokens: agentOutputTokens,
          share: shareOf(agentOutputTokens),
          colorToken: COLORS.agentOutput,
        }]
      : []),
    ...(userTokens > 0
      ? [{
          id: "user-messages",
          groupId: "user-messages" as const,
          label: "User messages",
          tokens: userTokens,
          share: shareOf(userTokens),
          colorToken: COLORS.userMessages,
        }]
      : []),
  ]

  const providerInputTokens = currentUsage?.inputTokens ?? null
  const providerOutputTokens = currentUsage?.outputTokens ?? null
  const providerTotalTokens = currentUsage?.totalTokens ?? null
  const providerReasoningTokens = currentUsage?.reasoningTokens ?? null
  const providerCachedTokens = currentUsage?.cachedTokens ?? null

  return {
    contextId: context.id,
    windowPosition: context.windowPosition,
    committedAt: context.committedAt,
    itemCount: context.items.length,
    toolCount: context.tools.length,
    windowTokens: providerInputTokens ?? context.measurement.knownSubtotal,
    windowTokensSource: providerInputTokens !== null ? "provider" : "estimated",
    knownSubtotal: context.measurement.knownSubtotal,
    coverage: context.measurement.coverage,
    unavailableCount: context.measurement.unavailable.length,
    groups,
    segments,
    providerInputTokens,
    providerOutputTokens,
    providerTotalTokens,
    providerReasoningTokens,
    providerCachedTokens,
    providerUsage: currentUsage !== null && currentUsage.entry.metrics.length > 0 ? [currentUsage.entry] : [],
  }
}
