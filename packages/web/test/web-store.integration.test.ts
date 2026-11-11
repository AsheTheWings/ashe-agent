import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { applyMigrations, discoverMigrations, readMigrationStatus } from "../src/backend/migrations.ts"
import { WebStore, WebStoreError } from "../src/backend/store.ts"

const migrations = discoverMigrations(join(import.meta.dir, "../migrations"))
const NOW = 1_800_000_000_000

const open = (path: string) => {
  const db = new Database(path, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  applyMigrations(db, migrations)
  return new WebStore(db)
}

const operation = (kind: "pin" | "snooze") =>
  kind === "pin"
    ? { kind: "organization.set" as const, operationId: `op-${Math.random()}`, sessionId: "s1", patch: { pinned: true } }
    : { kind: "organization.set" as const, operationId: `op-${Math.random()}`, sessionId: "s1", patch: { snoozedUntil: NOW + 1_000 } }

describe("web store", () => {
  test("owns an ordered migration ledger and a clean no-op rerun", () => {
    const dir = mkdtempSync(join(tmpdir(), "ashe-web-store-"))
    const path = join(dir, "state.sqlite")
    try {
      const db = new Database(path, { create: true })
      expect(readMigrationStatus(db, migrations).applied).toHaveLength(0)
      expect(applyMigrations(db, migrations)).toBe(1)
      expect(applyMigrations(db, migrations)).toBe(0)
      expect(readMigrationStatus(db, migrations).pending).toHaveLength(0)
      expect(db.query("SELECT count(*) AS n FROM web_schema_migrations").get()).toEqual({ n: 1 })
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("binds one harness and refuses another without rewriting the binding", () => {
    const dir = mkdtempSync(join(tmpdir(), "ashe-web-store-"))
    const store = open(join(dir, "state.sqlite"))
    try {
      store.bind("harness-a", NOW)
      expect(() => store.bind("harness-b", NOW)).toThrow(WebStoreError)
      expect(store.boundHarness()).toBe("harness-a")
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("repair selects a new empty location and leaves the old store byte-identical", () => {
    const dir = mkdtempSync(join(tmpdir(), "ashe-web-store-"))
    const oldPath = join(dir, "old.sqlite")
    const store = open(oldPath)
    try {
      store.bind("harness-a", NOW)
      store.ensureSession("old-session", NOW)
      store.apply("login:o", { kind: "organization.set", operationId: "old-pin", sessionId: "old-session", patch: { pinned: true } }, NOW)
    } finally {
      store.close()
    }
    const before = readFileSync(oldPath)
    const replacement = open(join(dir, "replacement.sqlite"))
    try {
      replacement.bind("harness-b", NOW + 1)
      replacement.ensureSession("new-session", NOW + 1)
      expect(replacement.boundHarness()).toBe("harness-b")
      expect(replacement.session("old-session")).toBeNull()
    } finally {
      replacement.close()
    }
    expect(readFileSync(oldPath)).toEqual(before)
    rmSync(dir, { recursive: true, force: true })
  })

  test("reconciliation does not turn retained history into current activity", () => {
    const dir = mkdtempSync(join(tmpdir(), "ashe-web-store-"))
    const store = open(join(dir, "state.sqlite"))
    try {
      store.ensureSession("s1", 1_000)
      store.reconcile({ sessionId: "s1", cursor: 50, now: 999_999, working: false, pendingText: false, needsHuman: false, available: false })
      expect(store.session("s1")?.lastActivityAt).toBe(1_000)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("deduplicates an operation and rejects a different payload under its identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "ashe-web-store-"))
    const store = open(join(dir, "state.sqlite"))
    store.ensureSession("s1", NOW)
    try {
      const command = { kind: "organization.set" as const, operationId: "same", sessionId: "s1", patch: { pinned: true } }
      const first = store.apply("login:o", command, NOW)
      const second = store.apply("login:o", command, NOW + 1)
      expect(first.receipt.outcome).toBe("confirmed")
      expect(second.receipt).toEqual(first.receipt)
      expect(second.changed).toEqual(first.changed)
      expect(() => store.apply("login:o", { ...command, patch: { pinned: false } }, NOW + 2)).toThrow(WebStoreError)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("preserves independent field changes and undo refuses a later overwrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "ashe-web-store-"))
    const store = open(join(dir, "state.sqlite"))
    store.ensureSession("s1", NOW)
    try {
      const pin = operation("pin")
      store.apply("login:o", pin, NOW)
      store.apply("login:o", operation("snooze"), NOW)
      expect(store.session("s1")).toMatchObject({ pinned: true, snoozedUntil: NOW + 1_000 })
      const undo = store.apply("login:o", { kind: "undo", operationId: "undo-1", undoOf: pin.operationId }, NOW + 2)
      expect(undo.receipt.outcome).toBe("confirmed")
      expect(store.session("s1")?.pinned).toBe(false)
      expect(store.session("s1")?.snoozedUntil).toBe(NOW + 1_000)
      const other = operation("pin")
      store.apply("login:o", other, NOW + 3)
      store.apply("login:o", { ...other, operationId: "pin-again", patch: { pinned: false } }, NOW + 4)
      expect(store.apply("login:o", { kind: "undo", operationId: "undo-2", undoOf: other.operationId }, NOW + 5).receipt.outcome).toBe("rejected")
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fences read acknowledgements with a generation", () => {
    const dir = mkdtempSync(join(tmpdir(), "ashe-web-store-"))
    const store = open(join(dir, "state.sqlite"))
    store.ensureSession("s1", NOW)
    try {
      const initial = store.session("s1")!
      expect(store.apply("login:o", { kind: "read.set", operationId: "r1", sessionId: "s1", unread: false, generation: initial.readGeneration }, NOW).receipt.outcome).toBe("confirmed")
      expect(store.session("s1")?.unread).toBe(false)
      store.apply("login:o", { kind: "read.set", operationId: "u1", sessionId: "s1", unread: true }, NOW + 1)
      expect(store.session("s1")?.readGeneration).toBe(initial.readGeneration + 1)
      expect(store.apply("login:o", { kind: "read.set", operationId: "r2", sessionId: "s1", unread: false, generation: initial.readGeneration }, NOW + 2).receipt.outcome).toBe("rejected")
      expect(store.session("s1")?.unread).toBe(true)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("requires fresh quiescence for manual filing and reopens on accepted work", () => {
    const dir = mkdtempSync(join(tmpdir(), "ashe-web-store-"))
    const store = open(join(dir, "state.sqlite"))
    store.ensureSession("s1", NOW)
    try {
      const row = store.session("s1")!
      expect(store.apply("login:o", { kind: "file.manual", operationId: "f-stale", sessionId: "s1", observedCursor: row.sourceCursor, observedRevision: row.revision }, NOW).receipt.outcome).toBe("rejected")
      store.setObserverConnected(true, NOW)
      store.markReconciled(NOW)
      store.reconcile({ sessionId: "s1", cursor: 4, now: NOW, working: true, pendingText: true, needsHuman: false, available: false })
      const busy = store.session("s1")!
      expect(store.apply("login:o", { kind: "file.manual", operationId: "f-busy", sessionId: "s1", observedCursor: busy.sourceCursor, observedRevision: busy.revision }, NOW).receipt.outcome).toBe("rejected")
      store.reconcile({ sessionId: "s1", cursor: 5, now: NOW, working: false, pendingText: false, needsHuman: false, available: false })
      const idle = store.session("s1")!
      store.markReconciled(NOW)
      expect(store.apply("login:o", { kind: "file.manual", operationId: "f-ok", sessionId: "s1", observedCursor: idle.sourceCursor, observedRevision: idle.revision }, NOW).receipt.outcome).toBe("confirmed")
      expect(store.session("s1")?.filed).toBe(true)
      store.observe({ sessionId: "s1", seq: 6, type: "INPUT_WAITING", now: NOW + 1, working: false, needsHuman: false, available: false, pendingText: true })
      expect(store.session("s1")?.filed).toBe(false)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("deduplicates observer replay and keeps the cursor with organization facts across restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "ashe-web-store-"))
    const path = join(dir, "state.sqlite")
    const store = open(path)
    try {
      store.ensureSession("s1", NOW)
      store.observe({ sessionId: "s1", seq: 7, type: "TEXT_MESSAGE_CONTENT", now: NOW + 1, working: true, needsHuman: false, available: false, pendingText: false })
      const revision = store.revision()
      expect(store.observe({ sessionId: "s1", seq: 7, type: "TEXT_MESSAGE_CONTENT", now: NOW + 2, working: true, needsHuman: false, available: false, pendingText: false })).toHaveLength(0)
      expect(store.revision()).toBe(revision)
    } finally {
      store.close()
    }
    const reopened = open(path)
    try {
      expect(reopened.session("s1")?.sourceCursor).toBe(7)
      expect(reopened.cursorFor("s1")).toBe(7)
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
