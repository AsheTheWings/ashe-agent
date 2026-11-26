import { describe, expect, test } from "bun:test"
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ModelCallContext, SemanticPageEntry, SessionObservation } from "@ashe-agent/protocol"
import { ClientProvider } from "../src/app/client-context.tsx"
import { SessionClient } from "../src/session/client.ts"
import {
  ActivityPreview,
  Chat,
  Checkpoint,
  CheckpointStatsBar,
  SessionNotebook,
  SessionNotifications,
  SessionStatsBar,
} from "../src/client/App.tsx"
import { Composer, composerPrimaryAction } from "../src/client/Composer.tsx"
import { WorkspaceHeader, type SessionNotificationEntry } from "../src/client/Header.tsx"
import { formatPayloadText, resolveScrollPaneHeight, TOOL_PANE_BASE_HEIGHT } from "../src/client/json-view.tsx"
import type { Draft } from "../src/client/drafts.ts"
import { computeCheckpointStats, computeSessionStats } from "../src/client/stats.ts"
import type { SessionView } from "../src/session/projection.ts"

const fakeClient = () =>
  new SessionClient({
    serverUrl: "ws://server.test/v1/ws",
    openSocket: () => ({ send: () => {}, close: () => {} }),
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    signIn: { storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, origin: "http://test", fragment: () => "", clearFragment: () => {}, navigate: () => {}, randomBytes: () => new Uint8Array() },
    withLock: async (_name, task) => await task(),
    now: () => 1,
    setTimer: () => 1,
    clearTimer: () => {},
  })

const render = (node: ReactNode) => renderToStaticMarkup(createElement(ClientProvider, { client: fakeClient(), children: node }))

const view: SessionView = {
  sessionId: "s1",
  lastSeq: 4,
  events: [],
  sessionDir: "/tmp/s1",
  agent: "untitled",
  model: "model-a",
  reasoningEffort: null,
  forkedFrom: null,
  runId: "r1",
  activeSelection: { agentTitle: "untitled", modelSettings: { modelId: "model-a", reasoningEffort: null } },
  items: [
    { kind: "user", id: "r1", seq: 1, runId: "r1", messages: [{ id: "i1", text: "hello there", mode: "steer", sender: { kind: "login", loginId: "alice" } }] },
    { kind: "developer", id: "d1", seq: 2, runId: "r1", components: [{ type: "notification", heading: "Developer secret", text: "peer details stay in Session" }] },
    {
      kind: "assistant",
      id: "r1:1",
      seq: 3,
      runId: "r1",
      status: "running",
      error: null,
      parts: [
        { type: "reasoning", id: "th1", modelCallId: "m1", text: "thinking about the task" },
        { type: "tool", id: "t1", modelCallId: "m1", name: "file_patch", argsText: "{\"path\":\"a.ts\"}", started: true, result: { content: "+ added line", outcome: "success" }, programCalls: [] },
        { type: "text", id: "x1", modelCallId: "m1", text: "**assistant** reply with `inline` code" },
      ],
    },
  ],
  pending: [],
  permissions: [],
  segments: { r1: 1 },
  streams: {},
  settled: [],
}

const observation: SessionObservation = {
  sessionId: "s1",
  revision: "rev-1",
  cursor: 4,
  selection: { agentTitle: "untitled", modelSettings: { modelId: "model-a", reasoningEffort: null } },
  activeSelection: view.activeSelection,
  pending: [],
  execution: { activeTurnId: "r1", activity: "working", canResume: false, canRewind: true, canFork: false, contextWorkflowActive: false, restorePending: false },
  userTurnIds: ["r1"],
  latestModelCallContextId: null,
  attention: [],
}

const sampleEntries: ReadonlyArray<SemanticPageEntry> = [
  {
    body: null,
    entry: {
      id: "e1",
      contentId: "c1",
      position: 1,
      turnId: null,
      kind: "developer-message",
      authorship: { sessionId: "s1", agentTitle: "untitled", modelId: null },
      ownership: { kind: "inherited", sourceSessionId: "source", sourceEntryId: "e0" },
      createdAt: 1,
      components: [
        { id: "dc1", type: "notification", heading: "Peer developer", text: "peer details stay in Session" },
        { id: "dc2", type: "state", heading: "Workspace state", text: "branch feat/web-ui-redesign is clean" },
      ],
    },
  },
  {
    body: null,
    entry: {
      id: "e2",
      contentId: "c2",
      position: 2,
      turnId: "r1",
      kind: "user-message",
      authorship: { sessionId: "s1", agentTitle: "untitled", modelId: null },
      ownership: { kind: "local" },
      createdAt: 2,
      parts: [{ kind: "text", text: "hello there" }],
    },
  },
  {
    body: null,
    entry: {
      id: "e3",
      contentId: "c3",
      position: 3,
      turnId: "r1",
      kind: "agent-tool",
      authorship: { sessionId: "s1", agentTitle: "untitled", modelId: "m1" },
      ownership: { kind: "local" },
      createdAt: 3,
      tool: {
        id: "t1",
        kind: "agent-tool",
        modelCallId: "m1",
        providerCallId: "call-file-patch-1",
        parentInvocationId: null,
        name: "file_patch",
        arguments: {
          id: "a1",
          kind: "structured",
          value: { patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch\n" },
        },
        startedAt: 2,
        settledAt: 3,
        outcome: "success",
        result: { structured: null, content: [{ id: "tc1", kind: "text", text: "+ added line" }] },
        captures: [],
      },
    },
  },
  {
    body: null,
    entry: {
      id: "e4",
      contentId: "c4",
      position: 4,
      turnId: "r1",
      kind: "agent-message",
      modelCallId: "m1",
      authorship: { sessionId: "s1", agentTitle: "untitled", modelId: "m1" },
      ownership: { kind: "local" },
      createdAt: 4,
      parts: [{ kind: "text", text: "All done!" }],
    },
  },
]

describe("owned three-view rendering", () => {
  test("Chat groups admitted user messages, renders safe markdown, and keeps thoughts, tools, and developer content out", () => {
    const html = render(createElement(Chat, { view, observation, onRewind: () => {}, onFork: () => {} }))
    expect(html).toContain("hello there")
    expect(html).toContain("<strong>assistant</strong>")
    expect(html).toContain("<code")
    expect(html).not.toContain("thinking about the task")
    expect(html).not.toContain("+ added line")
    expect(html).not.toContain("peer details stay in Session")
    expect(html).toContain("Rewind")
    expect(html).toContain("Edit")
    expect(html).toContain("Fork")
    expect(html).toContain("Copy")
    expect(html).toContain('data-slot="chat-extra-space"')
  })

  test("Session stacks expanded blocks with role-appropriate headers, colored tool JSON, and header stats", () => {
    const peerEntry: SemanticPageEntry = {
      body: null,
      entry: {
        id: "e5",
        contentId: "c5",
        position: 5,
        turnId: "r2",
        kind: "user-message",
        sender: { kind: "session", sessionId: "peer-1", agentTitle: "reviewer", modelId: "peer-model" },
        authorship: { sessionId: "s1", agentTitle: "untitled", modelId: "m1" },
        ownership: { kind: "local" },
        createdAt: 5,
        parts: [{ kind: "text", text: "hi from peer" }],
      },
    }
    const omittedEntry: SemanticPageEntry = {
      body: { contentId: "c6", referenceId: "e6", byteLength: 80_000 },
      entry: {
        id: "e6",
        contentId: "c6",
        position: 6,
        turnId: "r2",
        kind: "agent-message",
        modelCallId: "m2",
        authorship: { sessionId: "s1", agentTitle: "untitled", modelId: "m1" },
        ownership: { kind: "local" },
        createdAt: 6,
        parts: [],
      },
    }
    const thoughtEntry: SemanticPageEntry = {
      body: null,
      entry: {
        id: "e-thought",
        contentId: "c-thought",
        position: 8,
        turnId: "r1",
        kind: "agent-thought",
        modelCallId: "m1",
        authorship: { sessionId: "s1", agentTitle: "untitled", modelId: "m1" },
        ownership: { kind: "local" },
        createdAt: 8,
        text: "thinking about the task",
      },
    }
    const customToolEntry: SemanticPageEntry = {
      body: null,
      entry: {
        id: "e-custom-tool",
        contentId: "c-custom-tool",
        position: 9,
        turnId: "r1",
        kind: "agent-tool",
        authorship: { sessionId: "s1", agentTitle: "untitled", modelId: "m1" },
        ownership: { kind: "local" },
        createdAt: 9,
        tool: {
          id: "t-custom",
          kind: "agent-tool",
          modelCallId: "m1",
          providerCallId: "call-custom-1",
          parentInvocationId: null,
          name: "custom_tool",
          arguments: { id: "a-custom", kind: "structured", value: { path: "a.ts" } },
          startedAt: 8,
          settledAt: 9,
          outcome: "success",
          result: { structured: null, content: [{ id: "tc-custom", kind: "text", text: '{"ok":true}' }] },
          captures: [],
        },
      },
    }
    const html = render(createElement(SessionNotebook, { entries: [...sampleEntries, peerEntry, omittedEntry, thoughtEntry, customToolEntry] }))
    expect(html).toContain("DEVELOPER-MESSAGE")
    expect(html).toContain("USER-MESSAGE")
    expect(html).toContain("AGENT-TOOL")
    expect(html).toContain("AGENT-MESSAGE")
    expect(html).toContain("AGENT-THOUGHT")
    expect(html).toContain("peer details stay in Session")
    expect(html).toContain("inherited from source")
    expect(html).toContain("hello there")
    expect(html).toContain("+ added line")
    expect(html).toContain("FilePatch · a.ts")
    expect(html).toContain("*** Update File: a.ts")
    expect(html).toContain("custom_tool")
    expect(html).toContain('data-tool-id="call-file-patch-1"')
    expect(html).toContain('data-tool-id="call-custom-1"')
    expect(html).toContain('data-thought-id="m1"')
    expect(html).toContain('data-format="json"')
    expect(html).toContain("from peer-1")
    expect(html).toContain("/sessions/peer-1")
    expect(html).toContain("peer-model")
    expect(html).not.toContain("Load body")
    expect(html).not.toContain("omitted from page")
    expect(html).toContain("Loading content")
    expect(html.indexOf("peer details stay in Session")).toBeLessThan(html.indexOf("hello there"))

    // DEVELOPER-MESSAGE and human USER-MESSAGE omit agent/model identity.
    const devOnly = render(createElement(SessionNotebook, { entries: [sampleEntries[0]!] }))
    expect(devOnly).not.toContain("untitled")
    const humanUserOnly = render(createElement(SessionNotebook, { entries: [sampleEntries[1]!] }))
    expect(humanUserOnly).not.toContain("untitled")

    // Empty agent entries (tool/thought-only model calls with no text) are omitted from Session and stats.
    const emptyAgentEntry: SemanticPageEntry = {
      body: null,
      entry: {
        id: "e-empty-agent",
        contentId: "c-empty-agent",
        position: 7,
        turnId: "r2",
        kind: "agent-message",
        modelCallId: "m3",
        authorship: { sessionId: "s1", agentTitle: "untitled", modelId: "m1" },
        ownership: { kind: "local" },
        createdAt: 7,
        parts: [{ kind: "text", text: "   " }],
      },
    }
    const emptyAgentHtml = render(createElement(SessionNotebook, { entries: [emptyAgentEntry] }))
    expect(emptyAgentHtml).not.toContain("AGENT-MESSAGE")
    expect(emptyAgentHtml).toContain("No canonical history yet")
    expect(computeSessionStats([...sampleEntries, emptyAgentEntry]).agentMessages).toBe(1)

    expect(formatPayloadText('{"ok":true,"n":1}')).toEqual({
      isJson: true,
      text: '{\n  "ok": true,\n  "n": 1\n}',
    })
    expect(formatPayloadText("plain stdout")).toEqual({ isJson: false, text: "plain stdout" })

    // Paired tool panes keep baseline height for small or huge payloads, and expand within slack to avoid tiny scrollbars.
    expect(resolveScrollPaneHeight([48, 96])).toBe(TOOL_PANE_BASE_HEIGHT)
    expect(resolveScrollPaneHeight([217, 120])).toBe(217)
    expect(resolveScrollPaneHeight([260, 2_400])).toBe(260)
    expect(resolveScrollPaneHeight([600, 900])).toBe(TOOL_PANE_BASE_HEIGHT)

    const stats = computeSessionStats(sampleEntries)
    expect(stats.totalMessages).toBe(2)
    expect(stats.userMessages).toBe(1)
    expect(stats.agentMessages).toBe(1)
    expect(stats.toolCalls).toBe(1)
    expect(stats.mostUsedTool?.name).toBe("file_patch")

    const barHtml = render(createElement(SessionStatsBar, { entries: sampleEntries }))
    expect(barHtml).toContain("2 msgs")
    expect(barHtml).toContain("1 user")
    expect(barHtml).toContain("1 agent")
    expect(barHtml).toContain("file_patch")
  })

  test("Checkpoint renders semantic context items, transcripts, cleared tool results, and 3-group stacked stats", () => {
    const context: ModelCallContext = {
      id: "ctx1",
      modelCallId: "m2",
      turnId: "r1",
      windowPosition: 1,
      committedAt: 1,
      tools: [
        { name: "file_patch", description: "Apply a patch", parameters: { type: "object" } },
      ],
      items: [
        { kind: "system-message", sourceEntryId: "e0-sys", contentId: "c0-sys", byteLength: 400 },
        { kind: "developer-message", sourceEntryIds: ["e1"], transcript: null, byteLength: 80 },
        {
          kind: "developer-message",
          sourceEntryIds: ["e-foreign"],
          transcript: { id: "transcript:e-foreign", type: "transcript", heading: "Transcript", text: "# Transcript\n\nEarlier model turn." },
          byteLength: 120,
        },
        { kind: "user-message", sourceEntryId: "e2", byteLength: 20, attachments: [] },
        { kind: "agent-thought", sourceEntryId: null, modelCallId: "m1", opaque: true, byteLength: 0 },
        { kind: "agent-message", sourceEntryId: "e4", modelCallId: "m1", byteLength: 36 },
        { kind: "agent-tool", sourceEntryId: "e3", modelCallId: "m1", resultCleared: true, inputByteLength: 60, resultByteLength: 66, resultMedia: [] },
      ],
      measurement: { method: "ashe-agent-estimator", methodVersion: 1, purpose: "analysis", coverage: "partial", knownSubtotal: 200, contributions: [{ contributionPosition: 0, basis: "ashe-agent-text-v1", methodVersion: 1, tokens: 200, representationIds: ["c0-sys"] }], unavailable: [{ contributionPosition: 4, reason: "opaque provider replay state is not measured" }] },
    }
    const systemEntry: SemanticPageEntry = {
      body: null,
      entry: {
        id: "e0-sys",
        contentId: "c0-sys",
        position: 1,
        turnId: null,
        kind: "system-message",
        authorship: { sessionId: "s1", agentTitle: "untitled", modelId: null },
        ownership: { kind: "local" },
        createdAt: 1,
        content: { id: "e0-sys", kind: "text", text: "Harness rules for the session" },
      },
    }
    const html = render(createElement(Checkpoint, { context, entries: [systemEntry, ...sampleEntries] }))
    expect(html).not.toContain("INSTRUCTION")
    expect(html).not.toContain("PROVIDER-MESSAGE")
    expect(html).toContain("SYSTEM-MESSAGE")
    expect(html).toContain("Harness instructions")
    expect(html).toContain("Harness rules for the session")
    expect(html).toContain("Peer developer")
    expect(html).toContain("Workspace state")
    expect(html).toContain("Transcript")
    expect(html).toContain("Earlier model turn.")
    expect(html).toContain("Result cleared to free context")
    expect(html).toContain("tool definition")
    expect(html).toContain("file_patch")
    expect(html).toContain("Apply a patch")

    // Provider inputTokens is the window size; opaque thoughts are bounded by prior reasoningTokens and input gap.
    const usage = [
      { modelCallId: "m1", providerUsage: { inputTokens: 200, outputTokens: 525, totalTokens: 725, reasoningTokens: 500, cachedTokens: null } },
      { modelCallId: "m2", providerUsage: { inputTokens: 720, outputTokens: 30, totalTokens: 750, reasoningTokens: null, cachedTokens: null } },
    ]
    const stats = computeCheckpointStats(context, [systemEntry, ...sampleEntries], usage)
    expect(stats).not.toBeNull()
    expect(stats?.windowTokens).toBe(720)
    expect(stats?.windowTokensSource).toBe("provider")
    expect(stats?.groups.map((group) => group.label)).toEqual(["Harness", "Agent output", "User messages"])
    expect(stats?.groups[0]?.subgroups.map((sub) => sub.label)).toEqual([
      "System message",
      "Tool definitions",
      "Developer messages",
      "Tool results",
    ])
    const agentGroup = stats?.groups.find((group) => group.id === "agent-output")
    expect(agentGroup?.detail).toBe("includes opaque reasoning")
    expect(agentGroup?.tokens).toBeGreaterThan(400)
    expect(stats?.providerInputTokens).toBe(720)
    expect(stats?.providerOutputTokens).toBe(30)

    const barHtml = render(createElement(CheckpointStatsBar, { context, entries: [systemEntry, ...sampleEntries], usage }))
    expect(barHtml).toContain("720 tokens")
    expect(barHtml).toContain("30 out")
    expect(barHtml).toContain("Harness")
    expect(barHtml).toContain("Agent output")
    expect(barHtml).toContain("partial")
  })

  test("external image destinations render as inert consent placeholders and raw HTML is never evaluated", () => {
    const mediaView: SessionView = {
      ...view,
      items: [
        ...view.items.slice(0, 1),
        { kind: "assistant", id: "r1:2", seq: 4, runId: "r1", status: "running", error: null, parts: [{ type: "text", id: "x2", modelCallId: "m1", text: "look ![chart](https://example.test/chart.png) <script>alert(1)</script> [bad](javascript:alert(1))" }] },
      ],
    }
    const html = render(createElement(Chat, { view: mediaView, observation, onRewind: () => {}, onFork: () => {} }))
    expect(html).toContain("External image: chart")
    expect(html).toContain("https://example.test/chart.png")
    expect(html).toContain("Load")
    expect(html).not.toContain("<img src=\"https://example.test")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("javascript:alert")
  })

  test("Checkpoint has an explicit empty state and the activity preview persists when idle", () => {
    expect(render(createElement(Checkpoint, { context: null }))).toContain("No successful model request is retained")
    const activeHtml = render(createElement(ActivityPreview, { view, onReveal: () => {} }))
    expect(activeHtml).toContain("thinking about the task")
    expect(activeHtml).toContain("file_patch")
    expect(activeHtml).toContain("a.ts")

    const idleView: SessionView = { ...view, runId: null }
    const idleHtml = render(createElement(ActivityPreview, { view: idleView, onReveal: () => {} }))
    expect(idleHtml).toContain("thinking about the task")
    expect(idleHtml).toContain("file_patch")

    const emptyHtml = render(createElement(ActivityPreview, { view: { ...idleView, items: [] }, onReveal: () => {} }))
    expect(emptyHtml).toContain("No agent thoughts or tool calls yet")
  })

  test("SessionNotifications collapses to the latest entry and expands a 5-row scrollable viewport with ActivityPreview as an entry", () => {
    const entries: ReadonlyArray<SessionNotificationEntry> = [
      { id: "n6", kind: "notice", tone: "destructive", timestamp: 600, message: "Latest alert on top", actionLabel: "Retry", onAction: () => {} },
      { id: "n5", kind: "notice", tone: "warning", timestamp: 500, message: "Fifth entry" },
      { id: "n4", kind: "notice", tone: "info", timestamp: 400, message: "Fourth entry" },
      { id: "n3", kind: "notice", tone: "info", timestamp: 300, message: "Third entry" },
      { id: "n2", kind: "notice", tone: "info", timestamp: 200, message: "Second entry" },
      { id: "activity", kind: "activity", timestamp: 100, view, onReveal: () => {} },
    ]

    const collapsedHtml = render(createElement(SessionNotifications, { entries }))
    expect(collapsedHtml).toContain("Latest alert on top")
    expect(collapsedHtml).not.toContain("Fifth entry")
    expect(collapsedHtml).not.toContain('data-slot="session-notifications-list"')
    expect(collapsedHtml).toContain(">6</span>")

    const expandedHtml = render(createElement(SessionNotifications, { entries, defaultExpanded: true }))
    expect(expandedHtml).toContain('data-slot="session-notifications-list"')
    expect(expandedHtml).toContain("Latest alert on top")
    expect(expandedHtml).toContain("Fifth entry")
    expect(expandedHtml).toContain("thinking about the task")
    expect(expandedHtml).toContain("file_patch")
    expect(expandedHtml.indexOf("Latest alert on top")).toBeLessThan(expandedHtml.indexOf("Fifth entry"))
    expect(expandedHtml.indexOf("Fifth entry")).toBeLessThan(expandedHtml.indexOf("thinking about the task"))
  })

  test("WorkspaceHeader omits any Working badge near the session title while keeping Needs you", () => {
    const idleHeader = render(
      createElement(WorkspaceHeader, {
        title: "Active run",
        currentView: "chat",
        onViewChange: () => {},
        notifications: [],
        semanticEntries: [],
        checkpointContext: null,
        checkpointUsage: [],
        sidebarPinned: true,
        onToggleSidebar: () => {},
        attentionCount: 0,
        needsHuman: false,
        shortcuts: { viewModifier: "ctrl", typeToFocus: true },
      }),
    )
    expect(idleHeader).toContain("Active run")
    expect(idleHeader).not.toContain("Working")
    expect(idleHeader).not.toContain("Needs you")

    const attentionHeader = render(
      createElement(WorkspaceHeader, {
        title: "Active run",
        currentView: "chat",
        onViewChange: () => {},
        notifications: [],
        semanticEntries: [],
        checkpointContext: null,
        checkpointUsage: [],
        sidebarPinned: true,
        onToggleSidebar: () => {},
        attentionCount: 1,
        needsHuman: true,
        shortcuts: { viewModifier: "ctrl", typeToFocus: true },
      }),
    )
    expect(attentionHeader).toContain("Needs you")
    expect(attentionHeader).not.toContain("Working")
  })

  test("Composer swaps Stop and Send in a single action slot while a turn runs", () => {
    expect(composerPrimaryAction({ isRunning: false, stopping: false, canSend: false })).toBe("send")
    expect(composerPrimaryAction({ isRunning: false, stopping: false, canSend: true })).toBe("send")
    expect(composerPrimaryAction({ isRunning: true, stopping: false, canSend: false })).toBe("stop")
    expect(composerPrimaryAction({ isRunning: true, stopping: false, canSend: true })).toBe("send")
    expect(composerPrimaryAction({ isRunning: true, stopping: true, canSend: true })).toBe("stop")

    const baseDraft: Draft = {
      version: 1,
      id: "d1",
      authority: "h1:login:alice",
      sessionId: "s1",
      writerId: "w1",
      text: "",
      mode: "steer",
      selection: {},
      attachments: [],
      updatedAt: 1,
      source: null,
    }

    const emptyRunningHtml = render(
      createElement(Composer, {
        sessionId: "s1",
        draftStore: null,
        authority: null,
        draft: baseDraft,
        onDraft: () => {},
        view,
        observation,
        pending: [],
      }),
    )
    expect(emptyRunningHtml).toContain('aria-label="Stop"')
    expect(emptyRunningHtml).not.toContain(">Send<")

    const idleObservation: SessionObservation = {
      ...observation,
      execution: { ...observation.execution, activeTurnId: null, activity: "idle" },
    }
    const idleHtml = render(
      createElement(Composer, {
        sessionId: "s1",
        draftStore: null,
        authority: null,
        draft: baseDraft,
        onDraft: () => {},
        view: { ...view, runId: null },
        observation: idleObservation,
        pending: [],
      }),
    )
    expect(idleHtml).toContain(">Send<")
    expect(idleHtml).not.toContain('aria-label="Stop"')

    const centeredHtml = render(
      createElement(Composer, {
        variant: "centered",
        sessionId: "s1",
        draftStore: null,
        authority: null,
        draft: baseDraft,
        onDraft: () => {},
        view: { ...view, runId: null, items: [] },
        observation: idleObservation,
        pending: [],
      }),
    )
    expect(centeredHtml).toContain('data-slot="composer-centered-host"')
    expect(centeredHtml).toContain('data-variant="centered"')
    expect(centeredHtml).toContain('aria-label="Agent"')
    expect(centeredHtml).toContain('aria-label="Model: model-a"')
    expect(centeredHtml).toContain(">Send<")

    const baseRouteHtml = render(
      createElement(Composer, {
        variant: "centered",
        sessionId: null,
        draftStore: null,
        authority: null,
        draft: baseDraft,
        onDraft: () => {},
        view: undefined,
        observation: undefined,
        pending: [],
      }),
    )
    expect(baseRouteHtml).toContain('data-slot="composer-centered-host"')
    expect(baseRouteHtml).toContain('data-variant="centered"')
    expect(baseRouteHtml).not.toContain("Applies on send")
    expect(baseRouteHtml).toContain(">Send<")
  })
})
