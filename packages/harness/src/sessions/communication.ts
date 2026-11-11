import type { Database } from "bun:sqlite"
import { emitLog } from "../telemetry/signals.ts"
import type {
  AgentIdentity,
  MessageCategory,
  RetainedAttachmentRef,
} from "@ashe-agent/protocol"

export interface Publication {
  readonly publicationId: string
  readonly sourceSessionId: string
  readonly sourceMessageId: string | null
  readonly category: MessageCategory | "abnormal"
  readonly author: AgentIdentity
  readonly text: string
  readonly attachments: ReadonlyArray<RetainedAttachmentRef>
  readonly rootId: string | null
  readonly rootVisited: ReadonlyArray<string>
  readonly createdAt: number
}

export interface Delivery {
  readonly publication: Publication
  readonly inputId: string
  readonly receiverSessionId: string
  readonly rootId: string | null
  readonly visited: ReadonlyArray<string>
}

/** A causal root carried through an automatic subscription reaction. */
export interface Reaction {
  readonly publicationId?: string
  readonly rootId: string
  readonly visited: ReadonlyArray<string>
  readonly automatic: boolean
}

const categories = (value: string): ReadonlyArray<MessageCategory> => JSON.parse(value) as ReadonlyArray<MessageCategory>

const canonical = (messages: ReadonlyArray<MessageCategory>) => [...new Set(messages)].sort()

const normalized = (messages: ReadonlyArray<MessageCategory>) => {
  const selected = canonical(messages)
  if (selected.length === 0) throw new Error("a subscription must select at least one message category")
  return selected
}

/** Durable agent subscriptions, publication copies, causal roots, and fork intents. */
export class CommunicationStore {
  constructor(readonly db: Database) {}

  /** The categories one receiver selected for one source, or null without a subscription. */
  filter(receiverSessionId: string, sourceSessionId: string): ReadonlyArray<MessageCategory> | null {
    const row = this.db
      .query<{ messages: string }, [string, string]>(
        "SELECT messages FROM session_subscriptions WHERE receiver_session_id = ? AND source_session_id = ?",
      )
      .get(receiverSessionId, sourceSessionId)
    return row === null ? null : categories(row.messages)
  }

  /**
   * Records a turn-owned subscribe operation and sets the current filter,
   * removing pending optional deliveries the new filter no longer selects.
   */
  subscribe(
    receiverSessionId: string,
    sourceSessionId: string,
    messages: ReadonlyArray<MessageCategory>,
    actorSessionId: string,
    runId: string,
    now: number,
  ) {
    const selected = normalized(messages)
    this.db
      .query(
        `INSERT INTO subscription_operations
          (operation_id, receiver_session_id, source_session_id, actor_session_id, run_id, action, messages, created_at)
          VALUES (?, ?, ?, ?, ?, 'subscribe', ?, ?)`,
      )
      .run(crypto.randomUUID(), receiverSessionId, sourceSessionId, actorSessionId, runId, JSON.stringify(selected), now)
    this.db
      .query(
        `INSERT INTO session_subscriptions
          (receiver_session_id, source_session_id, messages, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (receiver_session_id, source_session_id)
          DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`,
      )
      .run(receiverSessionId, sourceSessionId, JSON.stringify(selected), now, now)
    this.removePending(receiverSessionId, sourceSessionId, selected, false)
  }

  /** Records a turn-owned unsubscribe operation, removes the filter, and removes pending deliveries. */
  unsubscribe(receiverSessionId: string, sourceSessionId: string, actorSessionId: string, runId: string, now: number) {
    this.db
      .query(
        `INSERT INTO subscription_operations
          (operation_id, receiver_session_id, source_session_id, actor_session_id, run_id, action, messages, created_at)
          VALUES (?, ?, ?, ?, ?, 'unsubscribe', '[]', ?)`,
      )
      .run(crypto.randomUUID(), receiverSessionId, sourceSessionId, actorSessionId, runId, now)
    this.db
      .query("DELETE FROM session_subscriptions WHERE receiver_session_id = ? AND source_session_id = ?")
      .run(receiverSessionId, sourceSessionId)
    this.removePending(receiverSessionId, sourceSessionId, [], true)
  }

  /** Removes pending deliveries outside `messages`; abnormal notices remain for filter replacement. */
  private removePending(
    receiverSessionId: string,
    sourceSessionId: string,
    messages: ReadonlyArray<MessageCategory>,
    includeAbnormal: boolean,
  ) {
    const allowed = JSON.stringify(messages)
    const rows = this.db
      .query<{ publication_id: string; input_id: string }, [string, string, string]>(
        `SELECT d.publication_id, d.input_id
          FROM subscription_deliveries d
          JOIN subscription_publications p ON p.publication_id = d.publication_id
          WHERE d.receiver_session_id = ? AND d.status = 'pending'
            AND p.source_session_id = ?
            AND (${includeAbnormal ? "1" : "p.category != 'abnormal'"})
            AND p.category NOT IN (SELECT value FROM json_each(?))`,
      )
      .all(receiverSessionId, sourceSessionId, allowed)
    if (rows.length === 0) return
    const inputIds = JSON.stringify(rows.map((row) => row.input_id))
    this.db
      .query(
        `DELETE FROM attachment_references WHERE session_id = ?
          AND reference_id IN (SELECT value FROM json_each(?))`,
      )
      .run(receiverSessionId, inputIds)
    this.db
      .query(
        `DELETE FROM waiting_input WHERE session_id = ?
          AND input_id IN (SELECT value FROM json_each(?))`,
      )
      .run(receiverSessionId, inputIds)
    this.db
      .query(
        `UPDATE subscription_deliveries SET status = 'removed'
          WHERE receiver_session_id = ? AND publication_id IN (SELECT value FROM json_each(?))`,
      )
      .run(receiverSessionId, JSON.stringify(rows.map((row) => row.publication_id)))
  }

  /** Marks pending deliveries for input removed by a recipient rewind as removed. */
  removeCleared(receiverSessionId: string, inputIds: ReadonlyArray<string>) {
    if (inputIds.length === 0) return
    this.db
      .query(
        `UPDATE subscription_deliveries SET status = 'removed'
          WHERE receiver_session_id = ? AND status = 'pending'
            AND input_id IN (SELECT value FROM json_each(?))`,
      )
      .run(receiverSessionId, JSON.stringify(inputIds))
  }

  /**
   * Rebuilds a receiver's current filters from the subscribe and unsubscribe
   * operations retained in its surviving turns, then removes pending optional
   * deliveries that no surviving filter selects.
   */
  reconcile(receiverSessionId: string) {
    const latest = this.db
      .query<{ source_session_id: string; action: "subscribe" | "unsubscribe"; messages: string; created_at: number }, [string]>(
        `SELECT o.source_session_id, o.action, o.messages, o.created_at
          FROM subscription_operations o
          WHERE o.receiver_session_id = ?
            AND o.rowid = (
              SELECT max(x.rowid) FROM subscription_operations x
              WHERE x.receiver_session_id = o.receiver_session_id
                AND x.source_session_id = o.source_session_id
            )`,
      )
      .all(receiverSessionId)
    this.db.query("DELETE FROM session_subscriptions WHERE receiver_session_id = ?").run(receiverSessionId)
    const insert = this.db.query(
      `INSERT INTO session_subscriptions
        (receiver_session_id, source_session_id, messages, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`,
    )
    for (const row of latest) {
      if (row.action !== "subscribe") continue
      insert.run(receiverSessionId, row.source_session_id, row.messages, row.created_at, row.created_at)
    }
    const pending = this.db
      .query<{ publication_id: string; input_id: string; source_session_id: string; category: string }, [string]>(
        `SELECT d.publication_id, d.input_id, p.source_session_id, p.category
          FROM subscription_deliveries d
          JOIN subscription_publications p ON p.publication_id = d.publication_id
          WHERE d.receiver_session_id = ? AND d.status = 'pending'`,
      )
      .all(receiverSessionId)
    for (const row of pending) {
      if (row.category === "abnormal") continue
      const filter = this.filter(receiverSessionId, row.source_session_id)
      if (filter !== null && (filter as ReadonlyArray<string>).includes(row.category)) continue
      this.db
        .query("DELETE FROM waiting_input WHERE session_id = ? AND input_id = ?")
        .run(receiverSessionId, row.input_id)
      this.db
        .query(
          "UPDATE subscription_deliveries SET status = 'removed' WHERE publication_id = ? AND receiver_session_id = ?",
        )
        .run(row.publication_id, receiverSessionId)
    }
  }

  /** The recipients selected for one publication, with their automatic-reaction provenance. */
  private recipients(publication: Publication): ReadonlyArray<{ readonly receiverSessionId: string; readonly visited: ReadonlyArray<string> }> {
    const rows = this.db
      .query<{ receiver_session_id: string; messages: string }, [string]>(
        "SELECT receiver_session_id, messages FROM session_subscriptions WHERE source_session_id = ?",
      )
      .all(publication.sourceSessionId)
    return rows.flatMap((row) => {
      if (publication.category !== "abnormal" && !(categories(row.messages) as ReadonlyArray<string>).includes(publication.category)) return []
      if (publication.category === "abnormal" && publication.rootVisited.includes(row.receiver_session_id)) {
        emitLog("ashe_agent.subscription.suppressed", {
          "ashe_agent.subscription.suppression_reason": "reentry",
        })
        return []
      }
      const visited =
        publication.category === "abnormal"
          ? [...new Set([...publication.rootVisited, publication.sourceSessionId, row.receiver_session_id])]
          : []
      return [{ receiverSessionId: row.receiver_session_id, visited }]
    })
  }

  /**
   * Records one publication once and returns the deliveries required. An
   * abnormal publication whose receiver already visited its causal root is
   * suppressed and reported separately.
   */
  publish(publication: Publication): ReadonlyArray<Delivery> {
    const dedupe =
      publication.category === "abnormal"
        ? `abnormal:${publication.sourceSessionId}:${publication.rootId}`
        : `${publication.category}:${publication.sourceMessageId ?? publication.rootId}`
    const inserted = this.db
      .query(
        `INSERT INTO subscription_publications
          (publication_id, dedupe_key, source_session_id, source_message_id, category, author, text, attachments, root_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .run(
        publication.publicationId,
        dedupe,
        publication.sourceSessionId,
        publication.sourceMessageId,
        publication.category,
        JSON.stringify(publication.author),
        publication.text,
        JSON.stringify(publication.attachments),
        publication.rootId,
        publication.createdAt,
      )
    if (inserted.changes === 0) return []
    const deliveries: Array<Delivery> = []
    for (const recipient of this.recipients(publication)) {
      const inputId = crypto.randomUUID()
      this.db
        .query(
          `INSERT INTO subscription_deliveries
            (publication_id, receiver_session_id, input_id, status, root_id, visited, created_at)
            VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          publication.publicationId,
          recipient.receiverSessionId,
          inputId,
          publication.rootId,
          JSON.stringify(recipient.visited),
          publication.createdAt,
        )
      deliveries.push({
        publication,
        inputId,
        receiverSessionId: recipient.receiverSessionId,
        rootId: publication.rootId,
        visited: recipient.visited,
      })
    }
    return deliveries
  }

  /** Marks a delivery's pending developer input admitted by its recipient turn. */
  admitted(receiverSessionId: string, inputId: string, at: number) {
    this.db
      .query(
        "UPDATE subscription_deliveries SET status = 'admitted', admitted_at = ? WHERE receiver_session_id = ? AND input_id = ? AND status = 'pending'",
      )
      .run(at, receiverSessionId, inputId)
  }

  recordReaction(sessionId: string, runId: string, reaction: Reaction) {
    const existing = this.db
      .query<{ visited: string; automatic: number }, [string, string, string]>(
        "SELECT visited, automatic FROM turn_reactions WHERE session_id = ? AND run_id = ? AND root_id = ?",
      )
      .get(sessionId, runId, reaction.rootId)
    if (existing === null) {
      this.db
        .query(
          `INSERT INTO turn_reactions (session_id, run_id, root_id, visited, automatic)
            VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sessionId, runId, reaction.rootId, JSON.stringify([...new Set(reaction.visited)]), reaction.automatic ? 1 : 0)
      return
    }
    const visited = [...new Set([...(JSON.parse(existing.visited) as ReadonlyArray<string>), ...reaction.visited])]
    this.db
      .query("UPDATE turn_reactions SET visited = ?, automatic = ? WHERE session_id = ? AND run_id = ? AND root_id = ?")
      .run(JSON.stringify(visited), existing.automatic === 1 || reaction.automatic ? 1 : 0, sessionId, runId, reaction.rootId)
  }

  reactions(sessionId: string, runId: string): ReadonlyArray<Reaction> {
    return this.db
      .query<{ root_id: string; visited: string; automatic: number }, [string, string]>(
        "SELECT root_id, visited, automatic FROM turn_reactions WHERE session_id = ? AND run_id = ? ORDER BY root_id",
      )
      .all(sessionId, runId)
      .map((row) => ({ rootId: row.root_id, visited: JSON.parse(row.visited), automatic: row.automatic === 1 }))
  }

  /** Creates or returns the durable intent for an accepted agent-fork invocation. */
  forkIntent(input: {
    readonly sourceSessionId: string
    readonly sourceRunId: string
    readonly sourceInvocationId: string
    readonly sourceModelCallId: string
    readonly sourceProviderCallId: string
    readonly branchSessionId: string
    readonly createdAt: number
  }): { readonly id: string; readonly status: "preparing" | "ready"; readonly branchSessionId: string } {
    this.db
      .query(
        `INSERT INTO agent_fork_intents
          (intent_id, source_session_id, source_run_id, source_invocation_id,
           source_model_call_id, source_provider_call_id, branch_session_id, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?)
          ON CONFLICT (source_session_id, source_invocation_id) DO NOTHING`,
      )
      .run(
        crypto.randomUUID(),
        input.sourceSessionId,
        input.sourceRunId,
        input.sourceInvocationId,
        input.sourceModelCallId,
        input.sourceProviderCallId,
        input.branchSessionId,
        input.createdAt,
      )
    const row = this.db
      .query<{ intent_id: string; status: "preparing" | "ready"; branch_session_id: string }, [string, string]>(
        "SELECT intent_id, status, branch_session_id FROM agent_fork_intents WHERE source_session_id = ? AND source_invocation_id = ?",
      )
      .get(input.sourceSessionId, input.sourceInvocationId)!
    return { id: row.intent_id, status: row.status, branchSessionId: row.branch_session_id }
  }

  pendingForkIntents() {
    return this.db
      .query<{
        intent_id: string
        source_session_id: string
        source_run_id: string
        source_invocation_id: string
        source_model_call_id: string
        source_provider_call_id: string
        branch_session_id: string
        status: "preparing" | "ready"
      }, []>("SELECT * FROM agent_fork_intents WHERE status = 'preparing' ORDER BY created_at, intent_id")
      .all()
  }

  forkReady(intentId: string) {
    this.db.query("UPDATE agent_fork_intents SET status = 'ready' WHERE intent_id = ?").run(intentId)
  }

  forkStatus(intentId: string): "preparing" | "ready" | null {
    return this.db
      .query<{ status: "preparing" | "ready" }, [string]>("SELECT status FROM agent_fork_intents WHERE intent_id = ?")
      .get(intentId)?.status ?? null
  }

  abandonFork(intentId: string) {
    this.db.query("DELETE FROM agent_fork_intents WHERE intent_id = ? AND status = 'preparing'").run(intentId)
  }
}
