import { describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { DraftStore } from "../src/client/drafts.ts"

const storage = () => {
  const window = new Window({ url: "https://ashe.example" })
  return { window, local: window.localStorage as unknown as Storage, session: window.localStorage as unknown as Storage }
}

describe("browser draft ownership", () => {
  test("detaches a submission and its next draft in one record, then another page recovers a copy", () => {
    const { local, session } = storage()
    const first = new DraftStore(local, session, () => 1)
    const initial = first.load("h1:login:alice", "s1")
    expect(initial.active).toMatchObject({ text: "", mode: "steer" })
    first.save("h1:login:alice", "s1", { text: "hello", mode: "steer", selection: {}, attachments: [] })
    const detached = first.detach("h1:login:alice", "s1", {
      submissionId: "sub-1",
      text: "hello",
      mode: "steer",
      selection: { agentTitle: "reviewer" },
      attachments: [],
    })
    expect(detached.ok).toBe(true)
    const record = first.load("h1:login:alice", "s1")
    expect(record.submissions).toHaveLength(1)
    expect(record.submissions[0]).toMatchObject({ submissionId: "sub-1", state: "sending" })
    expect(record.active?.text).toBe("")
    const second = new DraftStore(local, session, () => 2)
    expect(second.writerId).not.toBe(first.writerId)
    const candidates = second.candidates("h1:login:alice", "s1")
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.source).toBe(record.active?.id)
    const recovered = second.recover("h1:login:alice", "s1", candidates[0]!)
    expect(recovered.ok).toBe(true)
    const copy = second.load("h1:login:alice", "s1")
    expect(copy.active?.id).not.toBe(candidates[0]?.id)
    expect(copy.active?.source).toBe(candidates[0]?.id)
    expect(first.load("h1:login:alice", "s1").active?.id).toBe(record.active?.id)
  })

  test("explicit restore never overwrites active text and unsupported versions stay recoverable", () => {
    const { local, session } = storage()
    const store = new DraftStore(local, session, () => 1)
    store.save("h1:login:alice", "s1", { text: "newer edit", mode: "queue", selection: {}, attachments: [] })
    const submission = {
      version: 1 as const,
      submissionId: "sub-2",
      authority: "h1:login:alice",
      sessionId: "s1",
      text: "rejected old edit",
      mode: "steer" as const,
      selection: {},
      attachments: [],
      createdAt: 1,
      state: "rejected" as const,
    }
    expect(store.restore("h1:login:alice", "s1", submission).ok).toBe(true)
    const record = store.load("h1:login:alice", "s1")
    expect(record.active?.text).toBe("newer edit")
    expect(record.recoverable.map((draft) => draft.text)).toEqual(["rejected old edit"])
    local.setItem("ashe-agent.web.draft.v1:h1:login:alice:s1:old", JSON.stringify({ version: 99, text: "old" }))
    expect(store.unsupported("h1:login:alice", "s1")).toHaveLength(1)
    expect(local.getItem("ashe-agent.web.draft.v1:h1:login:alice:s1:old")).not.toBeNull()
  })

  test("repeated typing saves the active draft and recovery preserves a populated editor", () => {
    const { local, session } = storage()
    const store = new DraftStore(local, session, () => 1)
    store.load("h1:login:alice", "s1")
    store.save("h1:login:alice", "s1", { text: "h", mode: "steer", selection: {}, attachments: [] })
    store.save("h1:login:alice", "s1", { text: "hello", mode: "steer", selection: {}, attachments: [] })
    expect(store.load("h1:login:alice", "s1").active?.text).toBe("hello")
    const other = new DraftStore(local, session, () => 2)
    const candidate = other.candidates("h1:login:alice", "s1")[0]!
    other.save("h1:login:alice", "s1", { text: "mine", mode: "steer", selection: {}, attachments: [] })
    other.recover("h1:login:alice", "s1", candidate)
    const record = other.load("h1:login:alice", "s1")
    expect(record.active?.text).toBe("mine")
    expect(record.recoverable.some((draft) => draft.text === "hello" || draft.text === "h")).toBe(true)
  })

  test("reports unavailable storage and keeps authority partitions separate", () => {
    const { local, session } = storage()
    const store = new DraftStore(local, session, () => 1)
    store.save("h1:login:alice", "s1", { text: "alice", mode: "steer", selection: {}, attachments: [] })
    expect(store.candidates("h2:login:bob", "s1")).toHaveLength(0)
    const failing = {
      getItem: () => null,
      setItem: () => { throw new Error("quota exceeded") },
      removeItem: () => {},
      key: () => null,
      clear: () => {},
      length: 0,
    } as unknown as Storage
    const broken = new DraftStore(failing, session, () => 1)
    const result = broken.save("h1:login:alice", "s1", { text: "not durable", mode: "steer", selection: {}, attachments: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("quota exceeded")
  })

  test("promote swaps a recovery into the editor and caps retained copies", () => {
    const { local, session } = storage()
    const store = new DraftStore(local, session, () => 1)
    store.save("h1:login:alice", "s1", { text: "mine", mode: "steer", selection: {}, attachments: [] })
    for (let index = 0; index < 12; index += 1) {
      const other = new DraftStore(local, session, () => index + 2)
      other.save("h1:login:alice", "s1", { text: `theirs ${index}`, mode: "steer", selection: {}, attachments: [] })
      store.recover("h1:login:alice", "s1", other.candidates("h1:login:alice", "s1")[0]!)
    }
    const record = store.load("h1:login:alice", "s1")
    expect(record.active?.text).toBe("mine")
    expect(record.recoverable.length).toBe(10)
    store.promote("h1:login:alice", "s1", record.recoverable[0]!.id)
    const promoted = store.load("h1:login:alice", "s1")
    expect(promoted.active?.text).toContain("theirs")
    expect(promoted.recoverable.some((draft) => draft.text === "mine")).toBe(true)
  })

  test("revalidation expires a ready attachment by its staging identity", () => {
    const { local, session } = storage()
    const store = new DraftStore(local, session, () => 1)
    store.save("h1:login:alice", "s1", { text: "", mode: "steer", selection: {}, attachments: [{ uploadId: "retained", stagingUploadId: "staging", name: "a.txt", mediaType: "text/plain", size: 1, sha256: null, state: "ready" }] })
    store.expireAttachment("h1:login:alice", "s1", "staging")
    expect(store.load("h1:login:alice", "s1").active?.attachments[0]).toMatchObject({ state: "expired", uploadId: "retained" })
  })
})
