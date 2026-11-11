import { describe, expect, test } from "bun:test"
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ModelInputManifest, SemanticPageEntry, SessionObservation } from "@ashe-agent/protocol"
import { ClientProvider } from "../src/app/client-context.tsx"
import { SessionClient } from "../src/session/client.ts"
import { ActivityPreview, Chat, Checkpoint, SessionNotebook, ToolCall } from "../src/client/App.tsx"
import type { SessionView, ToolPart } from "../src/session/projection.ts"

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
        { type: "text", id: "x1", modelCallId: "m1", text: "assistant reply" },
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
  latestSuccessfulBoundaryId: null,
  attention: [],
}

describe("owned three-view rendering", () => {
  test("Chat groups admitted user messages, keeps developer content out, and shows activity previews", () => {
    const html = render(createElement(Chat, { view, observation, pending: [], onRewind: () => {}, onFork: () => {}, onReveal: () => {} }))
    expect(html).toContain("hello there")
    expect(html).toContain("assistant reply")
    expect(html).toContain("thinking about the task")
    expect(html).toContain("file_patch")
    expect(html).not.toContain("+ added line")
    expect(html).not.toContain("peer details stay in Session")
    expect(html).toContain("Rewind")
  })

  test("Session stacks typed blocks and keeps peer developer content with provenance", () => {
    const entries: ReadonlyArray<SemanticPageEntry> = [
      { body: null, entry: { id: "e1", contentId: "c1", position: 1, turnId: null, kind: "developer", authorship: { sessionId: "s1", agentTitle: "untitled", modelId: null }, ownership: { kind: "inherited", sourceSessionId: "source", sourceEntryId: "e0" }, createdAt: 1, components: [{ id: "dc1", type: "notification", heading: "Peer developer", text: "peer details stay in Session" }] } },
      { body: null, entry: { id: "e2", contentId: "c2", position: 2, turnId: "r1", kind: "user", authorship: { sessionId: "s1", agentTitle: "untitled", modelId: null }, ownership: { kind: "local" }, createdAt: 2, parts: [{ kind: "text", text: "hello there" }] } },
      { body: null, entry: { id: "e3", contentId: "c3", position: 3, turnId: "r1", kind: "agent-tool", authorship: { sessionId: "s1", agentTitle: "untitled", modelId: "m1" }, ownership: { kind: "local" }, createdAt: 3, tool: { id: "t1", kind: "agent-tool", modelCallId: "m1", providerCallId: null, parentInvocationId: null, name: "file_patch", arguments: { id: "a1", kind: "structured", value: { patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch\n" } }, startedAt: 2, settledAt: 3, outcome: "success", result: { structured: null, content: [{ id: "tc1", kind: "text", text: "+ added line" }] }, captures: [] } } },
    ]
    const html = render(createElement(SessionNotebook, { entries }))
    expect(html).toContain("peer details stay in Session")
    expect(html).toContain("inherited from source")
    expect(html).toContain("hello there")
    expect(html).toContain("+ added line")
    expect(html).toContain("FilePatch · a.ts")
    expect(html).toContain("*** Update File: a.ts")
    expect(html.indexOf("peer details stay in Session")).toBeLessThan(html.indexOf("hello there"))
  })

  test("Checkpoint names the latest boundary, partial measurement, definitions, and provider usage separately", () => {
    const manifest: ModelInputManifest = {
      id: "b1",
      modelCallId: "m1",
      turnId: "r1",
      windowPosition: 1,
      committedAt: 1,
      contributions: [
        { position: 0, kind: "message", sourceEntryId: "e2", sourceEntryIds: ["e2"], representation: { representationId: "r", contentId: "c", mediaType: "text/plain", digest: "d", transformation: null }, transformation: null, rendered: { representationId: "rr", contentId: "cc", mediaType: "text/plain", digest: "dd", byteLength: 5, renderer: "text@1" } },
        { position: 1, kind: "tool-definition", name: "file_patch", description: "Apply a patch", parameters: {}, rendered: { representationId: "rt", contentId: "ct", mediaType: "application/json", digest: "dt", byteLength: 2, renderer: "json@1" } },
        { position: 2, kind: "placeholder", sourceEntryId: "e1", reason: "cleared tool result" },
      ],
      measurement: { method: "ashe-agent-estimator", methodVersion: 1, purpose: "analysis", coverage: "partial", knownSubtotal: 5, contributions: [{ contributionPosition: 0, basis: "ashe-agent-text-v1", methodVersion: 1, tokens: 5, representationIds: ["rr"] }], unavailable: [{ contributionPosition: 2, reason: "cleared" }] },
    }
    const html = render(createElement(Checkpoint, { manifest, usage: [{ modelCallId: "m1", providerUsage: { inputTokens: 7, outputTokens: 3 } }] }))
    expect(html).toContain("Best-effort model input")
    expect(html).toContain("5 known tokens")
    expect(html).toContain("partial coverage")
    expect(html).toContain("tool definition · file_patch")
    expect(html).toContain("inputTokens")
    expect(html).toContain("placeholder · cleared tool result")
  })

  test("external image destinations render as inert consent placeholders", () => {
    const mediaView: SessionView = {
      ...view,
      items: [
        ...view.items.slice(0, 1),
        { kind: "assistant", id: "r1:2", seq: 4, runId: "r1", status: "running", error: null, parts: [{ type: "text", id: "x2", modelCallId: "m1", text: "look ![chart](https://example.test/chart.png)" }] },
      ],
    }
    const html = render(createElement(Chat, { view: mediaView, observation, pending: [], onRewind: () => {}, onFork: () => {}, onReveal: () => {} }))
    expect(html).toContain("External image: chart")
    expect(html).toContain("https://example.test/chart.png")
    expect(html).toContain("Load")
    expect(html).not.toContain("<img src=\"https://example.test")
  })

  test("tool dispatch uses the typed FilePatch block and preserves unknown input", () => {
    const part: ToolPart = { type: "tool", id: "t1", modelCallId: "m", name: "file_patch", argsText: "{\"path\":\"a.ts\"}", started: true, result: { content: "+ added", outcome: "success" }, programCalls: [] }
    const html = render(createElement(ToolCall, { part }))
    expect(html).toContain("FilePatch")
    expect(html).toContain("+ added")
    const fallback = render(createElement(ToolCall, { part: { ...part, name: "custom_tool" } }))
    expect(fallback).toContain("custom_tool")
    expect(fallback).toContain("a.ts")
  })

  test("Checkpoint has an explicit empty state and the activity preview follows the active segment", () => {
    expect(render(createElement(Checkpoint, { manifest: null, usage: [] }))).toContain("No successful model request is retained")
    const html = render(createElement(ActivityPreview, { view, onReveal: () => {} }))
    expect(html).toContain("thinking about the task")
    expect(html).toContain("file_patch")
  })
})
