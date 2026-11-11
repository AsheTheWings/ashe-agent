import type { InputMode, RetainedAttachmentRef, SelectionPatch } from "@ashe-agent/protocol"

export const DRAFT_FORMAT = 1 as const
const PREFIX = "ashe-agent.web.draft.v1"
const HINTS = "ashe-agent.web.tab-hints.v1"

export type DraftAttachment = {
  readonly uploadId: string
  /** The staging identity while the retained attachment id lives in `uploadId` after finalization. */
  readonly stagingUploadId?: string
  readonly name: string
  readonly mediaType: string
  readonly size: number
  readonly sha256: string | null
  readonly state: "preparing" | "ready" | "expired" | "failed"
  readonly attachment?: RetainedAttachmentRef
  readonly failure?: string
}

export type Draft = {
  readonly version: typeof DRAFT_FORMAT
  readonly id: string
  readonly authority: string
  readonly sessionId: string
  readonly writerId: string
  readonly text: string
  readonly mode: InputMode
  readonly selection: SelectionPatch
  readonly attachments: ReadonlyArray<DraftAttachment>
  readonly updatedAt: number
  readonly source: string | null
}

export type Submission = {
  readonly version: typeof DRAFT_FORMAT
  readonly submissionId: string
  readonly authority: string
  readonly sessionId: string
  readonly text: string
  readonly mode: InputMode
  readonly selection: SelectionPatch
  readonly attachments: ReadonlyArray<DraftAttachment>
  readonly createdAt: number
  readonly state: "sending" | "accepted" | "unknown" | "rejected"
  readonly message?: string
}

export type DraftRecord = {
  readonly version: 1
  readonly active: Draft | null
  readonly submissions: ReadonlyArray<Submission>
  readonly recoverable: ReadonlyArray<Draft>
}

export type DraftStoreResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

const empty = (): DraftRecord => ({ version: 1, active: null, submissions: [], recoverable: [] })

const key = (authority: string, sessionId: string, writerId: string) => `${PREFIX}:${authority}:${sessionId}:${writerId}`

/** The current page's writer identity; a reload always allocates a new one. */
export const newWriterId = () => crypto.randomUUID()

export class DraftStore {
  readonly writerId = newWriterId()

  constructor(
    private readonly storage: Storage,
    private readonly hints: Storage,
    private readonly now: () => number = Date.now,
  ) {}

  private readRecord(authority: string, sessionId: string, writerId: string): DraftRecord | null {
    const raw = this.storage.getItem(key(authority, sessionId, writerId))
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as DraftRecord
      if (parsed.version !== 1) return null
      return parsed
    } catch {
      return null
    }
  }

  /** The active record this page owns, creating it lazily. */
  load(authority: string, sessionId: string): DraftRecord {
    const record = this.readRecord(authority, sessionId, this.writerId)
    if (record !== null) return record
    const next: DraftRecord = { ...empty(), active: newDraft(authority, sessionId, this.writerId, this.now()) }
    this.write(authority, sessionId, next)
    this.remember(authority, sessionId)
    return next
  }

  private write(authority: string, sessionId: string, record: DraftRecord): DraftStoreResult {
    try {
      this.storage.setItem(key(authority, sessionId, this.writerId), JSON.stringify(record))
      this.remember(authority, sessionId)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "browser storage is unavailable" }
    }
  }

  private remember(authority: string, sessionId: string) {
    try {
      const raw = this.hints.getItem(HINTS)
      const hints = raw === null ? [] : (JSON.parse(raw) as Array<{ authority: string; sessionId: string; writerId: string; at: number }>)
      const next = hints.filter((hint) => !(hint.authority === authority && hint.sessionId === sessionId && hint.writerId === this.writerId))
      next.push({ authority, sessionId, writerId: this.writerId, at: this.now() })
      this.hints.setItem(HINTS, JSON.stringify(next.slice(-100)))
    } catch {
      // A missing hint only hides an explicit recovery candidate; it never deletes a draft.
    }
  }

  /** Other page records this tab can explicitly recover, never the active page's own record. */
  candidates(authority: string, sessionId: string): ReadonlyArray<Draft> {
    try {
      const raw = this.hints.getItem(HINTS)
      if (raw === null) return []
      const hints = JSON.parse(raw) as Array<{ authority: string; sessionId: string; writerId: string }>
      return hints
        .filter((hint) => hint.authority === authority && hint.sessionId === sessionId && hint.writerId !== this.writerId)
        .flatMap((hint) => {
          const record = this.readRecord(authority, sessionId, hint.writerId)
          return record?.active === null || record?.active === undefined ? [] : [record.active]
        })
    } catch {
      return []
    }
  }

  save(authority: string, sessionId: string, draft: Omit<Draft, "version" | "id" | "authority" | "sessionId" | "writerId" | "updatedAt" | "source">): DraftStoreResult {
    const record = this.load(authority, sessionId)
    const active: Draft = {
      version: DRAFT_FORMAT,
      id: record.active?.id ?? crypto.randomUUID(),
      authority,
      sessionId,
      writerId: this.writerId,
      updatedAt: this.now(),
      source: record.active?.source ?? null,
      ...draft,
    }
    return this.write(authority, sessionId, { ...record, active })
  }

  /** Makes a stored recovery draft active, keeping any current text recoverable. */
  promote(authority: string, sessionId: string, draftId: string): DraftStoreResult {
    const record = this.load(authority, sessionId)
    const target = record.recoverable.find((draft) => draft.id === draftId)
    if (target === undefined) return { ok: true }
    const rest = record.recoverable.filter((draft) => draft.id !== draftId)
    const kept = record.active !== null && record.active.text.trim() !== "" ? [...rest, record.active] : rest
    return this.write(authority, sessionId, { ...record, active: { ...target, updatedAt: this.now() }, recoverable: kept.slice(-10) })
  }

  /** Marks one staged upload expired after revalidation. */
  expireAttachment(authority: string, sessionId: string, uploadId: string): DraftStoreResult {
    const record = this.load(authority, sessionId)
    if (record.active === null) return { ok: true }
    return this.write(authority, sessionId, {
      ...record,
      active: {
        ...record.active,
        updatedAt: this.now(),
        attachments: record.active.attachments.map((attachment) =>
          attachment.uploadId === uploadId || attachment.stagingUploadId === uploadId ? { ...attachment, state: "expired", failure: "Re-upload the original file." } : attachment,
        ),
      },
    })
  }

  /** Commits the detached submission and the next empty draft in one storage write. */
  detach(
    authority: string,
    sessionId: string,
    submission: Omit<Submission, "version" | "state" | "createdAt" | "authority" | "sessionId">,
  ): DraftStoreResult {
    const record = this.load(authority, sessionId)
    const detached: Submission = {
      version: DRAFT_FORMAT,
      authority,
      sessionId,
      state: "sending",
      createdAt: this.now(),
      ...submission,
    }
    const next: DraftRecord = {
      ...record,
      active: { ...(record.active ?? newDraft(authority, sessionId, this.writerId, this.now())), text: "", attachments: [], source: record.active?.id ?? null, updatedAt: this.now() },
      submissions: [...record.submissions, detached],
    }
    return this.write(authority, sessionId, next)
  }

  updateSubmission(authority: string, sessionId: string, submissionId: string, change: Partial<Pick<Submission, "state" | "message">>): DraftStoreResult {
    const record = this.load(authority, sessionId)
    return this.write(authority, sessionId, {
      ...record,
      submissions: record.submissions.map((submission) => (submission.submissionId === submissionId ? { ...submission, ...change } : submission)),
    })
  }

  /** Copies another writer's draft into a new active record; the source stays untouched. */
  recover(authority: string, sessionId: string, source: Draft): DraftStoreResult {
    const record = this.load(authority, sessionId)
    const active: Draft = {
      ...source,
      id: crypto.randomUUID(),
      authority,
      sessionId,
      writerId: this.writerId,
      updatedAt: this.now(),
      source: source.id,
      attachments: source.attachments.map((attachment) =>
        attachment.state === "ready" ? attachment : { ...attachment, state: "expired", failure: "Re-upload the original file." },
      ),
    }
    if (record.active !== null && record.active.text.trim() !== "") {
      return this.write(authority, sessionId, { ...record, recoverable: [...record.recoverable, active].slice(-10) })
    }
    return this.write(authority, sessionId, { ...record, active })
  }

  /** Restores a rejected submission as a draft without overwriting text already present. */
  restore(authority: string, sessionId: string, submission: Submission): DraftStoreResult {
    const record = this.load(authority, sessionId)
    const restored: Draft = {
      ...newDraft(authority, sessionId, this.writerId, this.now()),
      text: submission.text,
      mode: submission.mode,
      selection: submission.selection,
      attachments: submission.attachments,
      source: submission.submissionId,
    }
    if (record.active !== null && record.active.text.trim() !== "") {
      return this.write(authority, sessionId, { ...record, recoverable: [...record.recoverable, restored].slice(-10) })
    }
    return this.write(authority, sessionId, { ...record, active: restored })
  }

  unsupported(authority: string, sessionId: string): ReadonlyArray<{ readonly key: string; readonly raw: string }> {
    const result: Array<{ key: string; raw: string }> = []
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index)
      if (key === null || !key.startsWith(`${PREFIX}:${authority}:${sessionId}:`)) continue
      const raw = this.storage.getItem(key)
      if (raw === null) continue
      try {
        const parsed = JSON.parse(raw) as { version?: unknown }
        if (parsed.version !== 1) result.push({ key, raw })
      } catch {
        result.push({ key, raw })
      }
    }
    return result
  }

  export(record: Draft | Submission): string {
    return JSON.stringify(record, null, 2)
  }
}

export const newDraft = (authority: string, sessionId: string, writerId: string, now: number): Draft => ({
  version: DRAFT_FORMAT,
  id: crypto.randomUUID(),
  authority,
  sessionId,
  writerId,
  text: "",
  mode: "steer",
  selection: {},
  attachments: [],
  updatedAt: now,
  source: null,
})
