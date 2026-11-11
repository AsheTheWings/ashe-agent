import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  AgentTool,
  Measurement,
  ModelCallDiscarded,
  ModelInputManifest,
  OwnerIdentity,
  SelectionPatch,
  SessionSummary,
  UploadStatus,
  methods,
} from "../src/index.ts"

const decodes = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownExit(schema as unknown as Schema.Codec<unknown, unknown>)(value, {
    onExcessProperty: "error",
  })._tag === "Success"

describe("selection contracts", () => {
  test("omission inherits while null clears the selected value", () => {
    expect(decodes(SelectionPatch, {})).toBe(true)
    expect(decodes(SelectionPatch, { agentTitle: "writer", modelSettings: { modelId: null, reasoningEffort: null } })).toBe(true)
    expect(decodes(SelectionPatch, { modelSettings: {} })).toBe(true)
  })

  test("the selection patch is closed to derived and provider settings", () => {
    expect(decodes(SelectionPatch, { temperature: 0.2 })).toBe(false)
    expect(decodes(SelectionPatch, { modelSettings: { temperature: 0.2 } })).toBe(false)
    expect(decodes(SelectionPatch, { checkpointWindowSize: 200_000 })).toBe(false)
  })

  test("an unconfigured model stays null in summaries and identity", () => {
    const summary = {
      id: "s1",
      sessionDir: "/sessions/s1",
      identity: { sessionId: "s1", agentTitle: "untitled", modelId: null },
      selection: { agentTitle: "untitled", modelSettings: { modelId: null, reasoningEffort: null } },
      activeSelection: null,
      activity: "idle",
      createdAt: 1,
      lastSeq: 2,
    }
    expect(decodes(SessionSummary, summary)).toBe(true)
    const { modelId: _, ...withoutModel } = summary.identity
    expect(decodes(SessionSummary, { ...summary, identity: withoutModel })).toBe(false)
  })
})

describe("owned semantic content", () => {
  test("one tool identity owns structured arguments, lifecycle, and its structured result", () => {
    const tool = {
      id: "tool-1",
      kind: "agent-tool",
      modelCallId: "mc-1",
      providerCallId: "call_1",
      parentInvocationId: null,
      name: "shell_exec_command",
      arguments: { id: "args-1", kind: "structured", value: { command: "printf hi" } },
      startedAt: 1,
      settledAt: 2,
      outcome: "success",
      result: {
        content: [{ id: "text-1", kind: "text", text: "hi" }],
        structured: { id: "result-1", kind: "structured", value: { exitCode: 0 } },
      },
    }
    expect(decodes(AgentTool, tool)).toBe(true)
    expect(decodes(AgentTool, { ...tool, providerCallId: null })).toBe(true)
  })

  test("a successful boundary retains ordered contributions and offered definitions", () => {
    const manifest = {
      id: "boundary-1",
      modelCallId: "mc-1",
      windowId: "window-1",
      committedAt: 3,
      contributions: [
        {
          position: 1,
          kind: "instruction",
          sourceEntryId: null,
          representation: {
            representationId: "rep-1",
            contentId: "content-1",
            mediaType: "text/plain",
            digest: "sha256:1",
            transformation: null,
          },
          transformation: null,
        },
        {
          position: 2,
          kind: "tool-definition",
          name: "file_read",
          description: "Read a file",
          parameters: { type: "object" },
        },
      ],
    }
    expect(decodes(ModelInputManifest, manifest)).toBe(true)
  })

  test("partial measurement identifies unavailable coverage instead of counting it as zero", () => {
    const measurement = {
      method: "ashe-agent-estimator",
      methodVersion: 1,
      coverage: "partial",
      knownSubtotal: 1_000,
      contributions: [
        {
          contributionPosition: 1,
          basis: "ashe-agent-text-v1",
          methodVersion: 1,
          tokens: 1_000,
          representationIds: ["text-1"],
        },
        {
          contributionPosition: 2,
          basis: "unavailable",
          methodVersion: 1,
          tokens: null,
          representationIds: ["pdf-1"],
          unavailableReason: "provider page expansion is unmeasured",
        },
      ],
      unavailable: [{ contributionPosition: 2, reason: "provider page expansion is unmeasured" }],
    }
    const [known, opaque] = measurement.contributions
    expect(decodes(Measurement, measurement)).toBe(true)
    expect(decodes(Measurement, { ...measurement, unavailable: [] })).toBe(false)
    expect(decodes(Measurement, { ...measurement, coverage: "complete" })).toBe(false)
    expect(decodes(Measurement, { ...measurement, contributions: [], knownSubtotal: 0, unavailable: [] })).toBe(false)
    expect(decodes(Measurement, { ...measurement, contributions: [known], knownSubtotal: 1_000, unavailable: [] })).toBe(false)
    expect(decodes(Measurement, { ...measurement, knownSubtotal: 2_000 })).toBe(false)
    expect(decodes(Measurement, { ...measurement, contributions: [known, { ...opaque, tokens: 0 }] })).toBe(false)
    expect(
      decodes(Measurement, {
        ...measurement,
        contributions: [known, { ...opaque, unavailableReason: undefined }],
      }),
    ).toBe(false)
    expect(
      decodes(Measurement, {
        ...measurement,
        unavailable: [{ contributionPosition: 1, reason: "provider page expansion is unmeasured" }],
      }),
    ).toBe(false)
  })

  test("a discarded model call names its request identity and reason", () => {
    expect(decodes(ModelCallDiscarded, { type: "MODEL_CALL_DISCARDED", runId: "r1", modelCallId: "mc1", reason: "cancelled" })).toBe(true)
    expect(decodes(ModelCallDiscarded, { type: "MODEL_CALL_DISCARDED", runId: "r1", reason: "cancelled" })).toBe(false)
  })
})

describe("owner contracts", () => {
  test("API credentials have an explicit null expiry", () => {
    const principal = { kind: "token", tokenId: "t1", name: "client" } as const
    expect(decodes(OwnerIdentity, { principal, credentialExpiresAt: null })).toBe(true)
    expect(decodes(OwnerIdentity, { principal, credentialExpiresAt: 10 })).toBe(true)
  })

  test("resumable upload identity is stable across offset and finalization states", () => {
    const upload = {
      uploadId: "u1",
      draftId: "d1",
      filename: "report.pdf",
      mediaType: "application/pdf",
      offset: 1_048_576,
      size: 2_000_000,
      digest: null,
      createdAt: 1,
      expiresAt: 2,
      claimed: false,
    }
    expect(decodes(UploadStatus, upload)).toBe(true)
    expect(decodes(UploadStatus, { ...upload, offset: 2_000_000, digest: "sha256:x", claimed: true })).toBe(true)
  })
})

describe("method contracts", () => {
  test("selection changes travel with input and rewind rather than a picker mutation", () => {
    expect("session.setModel" in methods).toBe(false)
    expect(decodes(methods["session.input"].params, {
      sessionId: "s1",
      text: "continue",
      selection: { agentTitle: "writer", modelSettings: { reasoningEffort: null } },
    })).toBe(true)
    expect(decodes(methods["session.rewind"].params, {
      sessionId: "s1",
      runId: "r1",
      selection: { modelSettings: { modelId: null } },
    })).toBe(true)
  })

  test("owner grants and uploads are owner-client methods outside the session tool namespace", () => {
    expect(methods["session.grants.list"]).toBeDefined()
    expect(methods["session.grants.clear"]).toBeDefined()
    expect(methods["upload.create"]).toBeDefined()
    expect(methods["upload.append"]).toBeDefined()
    expect(methods["upload.finalize"]).toBeDefined()
  })
})
