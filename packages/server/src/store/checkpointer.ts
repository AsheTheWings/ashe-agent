/*
 * A LangGraph checkpoint saver on bun:sqlite, derived from
 * @langchain/langgraph-checkpoint-sqlite 1.1.0, which is:
 *
 * Copyright (c) 2024 LangChain
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import type { Database, Statement } from "bun:sqlite"
import type { RunnableConfig } from "@langchain/core/runnables"
import {
  BaseCheckpointSaver,
  TASKS,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  copyCheckpoint,
  maxChannelVersion,
  writesSortKey,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type ChannelVersions,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint"

interface CheckpointRow {
  thread_id: string
  checkpoint_ns: string
  checkpoint_id: string
  parent_checkpoint_id: string | null
  type: string | null
  checkpoint: Uint8Array
  metadata: Uint8Array
  pending_writes: string
}

interface WriteColumn {
  task_id: string
  channel: string
  type: string | null
  value: string | null
  task_path: string
  idx: number
}

const selectCheckpoints = `
  SELECT
    thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata,
    (
      SELECT json_group_array(json_object(
        'task_id', pw.task_id, 'channel', pw.channel, 'type', pw.type,
        'value', CAST(pw.value AS TEXT), 'task_path', pw.task_path, 'idx', pw.idx
      ))
      FROM checkpoint_writes AS pw
      WHERE pw.thread_id = checkpoints.thread_id
        AND pw.checkpoint_ns = checkpoints.checkpoint_ns
        AND pw.checkpoint_id = checkpoints.checkpoint_id
    ) AS pending_writes
  FROM checkpoints`

/** Pending writes in `writesSortKey` order, sorted here so no database collation decides it. */
const sortWrites = (columns: ReadonlyArray<WriteColumn>) =>
  columns
    .map((column) => ({ key: writesSortKey(column.task_path, column.task_id, column.idx), column }))
    .sort((a, b) => compareWritesSortKeys(a.key, b.key))
    .map(({ column }) => column)

/**
 * Stores LangGraph checkpoints and pending writes in the server database's
 * `checkpoints`, `checkpoint_blobs`, and `checkpoint_writes` tables, which
 * migrations create. A checkpoint row holds no channel values: each value
 * is a blob keyed by channel and version, written only when `put` names its
 * version as new, and a checkpoint reads the values its versions name.
 */
export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  private readonly latest: Statement<CheckpointRow, [string, string]>
  private readonly byId: Statement<CheckpointRow, [string, string, string]>
  private readonly blob: Statement<{ type: string; blob: Uint8Array | null }, [string, string, string, string]>

  constructor(
    private readonly db: Database,
    serde?: SerializerProtocol,
  ) {
    super(serde)
    this.latest = db.query(
      `${selectCheckpoints} WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1`,
    )
    this.byId = db.query(`${selectCheckpoints} WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`)
    this.blob = db.query(
      "SELECT type, blob FROM checkpoint_blobs WHERE thread_id = ? AND checkpoint_ns = ? AND channel = ? AND version = ?",
    )
  }

  private async channelValues(threadId: string, checkpointNs: string, versions: ChannelVersions) {
    const values: Record<string, unknown> = {}
    for (const [channel, version] of Object.entries(versions)) {
      const row = this.blob.get(threadId, checkpointNs, channel, String(version))
      if (row === null || row.type === "empty" || row.blob === null) continue
      values[channel] = await this.serde.loadsTyped(row.type, row.blob)
    }
    return values
  }

  private async toTuple(row: CheckpointRow, config: RunnableConfig): Promise<CheckpointTuple> {
    const pendingWrites = await Promise.all(
      sortWrites(JSON.parse(row.pending_writes) as Array<WriteColumn>).map(
        async (write) =>
          [write.task_id, write.channel, await this.serde.loadsTyped(write.type ?? "json", write.value ?? "")] as [
            string,
            string,
            unknown,
          ],
      ),
    )
    const stored = (await this.serde.loadsTyped(row.type ?? "json", row.checkpoint)) as Checkpoint
    const checkpoint: Checkpoint = {
      ...stored,
      channel_values: await this.channelValues(row.thread_id, row.checkpoint_ns, stored.channel_versions),
    }
    if (checkpoint.v < 4 && row.parent_checkpoint_id !== null) {
      await this.migratePendingSends(checkpoint, row.thread_id, row.parent_checkpoint_id)
    }
    const metadata = (await this.serde.loadsTyped(row.type ?? "json", row.metadata)) as CheckpointMetadata
    const tuple: CheckpointTuple = { checkpoint, config, metadata, pendingWrites }
    if (row.parent_checkpoint_id !== null) {
      tuple.parentConfig = {
        configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.parent_checkpoint_id },
      }
    }
    return tuple
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {}
    const row = checkpoint_id
      ? this.byId.get(thread_id, checkpoint_ns, checkpoint_id)
      : this.latest.get(thread_id, checkpoint_ns)
    if (row === null) return undefined
    const finalConfig = checkpoint_id
      ? config
      : { configurable: { thread_id: row.thread_id, checkpoint_ns, checkpoint_id: row.checkpoint_id } }
    if (finalConfig.configurable?.thread_id === undefined || finalConfig.configurable?.checkpoint_id === undefined) {
      throw new Error("Missing thread_id or checkpoint_id")
    }
    return this.toTuple(row, finalConfig)
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {}
    const threadId = config.configurable?.thread_id
    const checkpointNs = config.configurable?.checkpoint_ns
    const where: Array<string> = []
    const args: Array<string | number> = []
    if (threadId) {
      where.push("thread_id = ?")
      args.push(threadId)
    }
    if (checkpointNs !== undefined && checkpointNs !== null) {
      where.push("checkpoint_ns = ?")
      args.push(checkpointNs)
    }
    if (before?.configurable?.checkpoint_id !== undefined) {
      where.push("checkpoint_id < ?")
      args.push(before.configurable.checkpoint_id)
    }
    for (const [key, value] of Object.entries(filter ?? {})) {
      if (value === undefined) continue
      where.push("jsonb(CAST(metadata AS TEXT)) -> ? = ?")
      args.push(`$.${key}`, JSON.stringify(value))
    }
    let sql = selectCheckpoints
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`
    sql += " ORDER BY checkpoint_id DESC"
    if (limit) sql += ` LIMIT ${Number.parseInt(String(limit), 10)}`
    const rows = this.db.query<CheckpointRow, Array<string | number>>(sql).all(...args)
    for (const row of rows) {
      yield await this.toTuple(row, {
        configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.checkpoint_id },
      })
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    if (!config.configurable) throw new Error("Empty configuration supplied.")
    const threadId = config.configurable.thread_id
    const checkpointNs = config.configurable.checkpoint_ns ?? ""
    const parentCheckpointId = config.configurable.checkpoint_id ?? null
    if (!threadId) throw new Error(`Missing "thread_id" field in passed "config.configurable".`)
    const { channel_values: values, ...rest } = copyCheckpoint(checkpoint)
    const blobs = await Promise.all(
      Object.entries(newVersions).map(async ([channel, version]) => {
        if (!(channel in values)) return [channel, String(version), "empty", null] as const
        const [type, serialized] = await this.serde.dumpsTyped(values[channel])
        return [channel, String(version), type, serialized] as const
      }),
    )
    const [[checkpointType, serializedCheckpoint], [metadataType, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped({ ...rest, channel_values: {} }),
      this.serde.dumpsTyped(metadata),
    ])
    if (checkpointType !== metadataType) throw new Error("Failed to serialized checkpoint and metadata to the same type.")
    const insertBlob = this.db.query(
      `INSERT OR REPLACE INTO checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob)
        VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const insertCheckpoint = this.db.query(
      `INSERT OR REPLACE INTO checkpoints
        (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    this.db.transaction(() => {
      for (const [channel, version, type, blob] of blobs) {
        insertBlob.run(threadId, checkpointNs, channel, version, type, blob)
      }
      insertCheckpoint.run(
        threadId,
        checkpointNs,
        checkpoint.id,
        parentCheckpointId,
        checkpointType,
        serializedCheckpoint,
        serializedMetadata,
      )
    })()
    return { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpoint.id } }
  }

  async putWrites(config: RunnableConfig, writes: Array<PendingWrite>, taskId: string, taskPath?: string): Promise<void> {
    if (!config.configurable) throw new Error("Empty configuration supplied.")
    if (!config.configurable.thread_id) throw new Error("Missing thread_id field in config.configurable.")
    if (!config.configurable.checkpoint_id) throw new Error("Missing checkpoint_id field in config.configurable.")
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP)
    const rows = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [type, serialized] = await this.serde.dumpsTyped(value)
        return [
          config.configurable!.thread_id,
          config.configurable!.checkpoint_ns ?? "",
          config.configurable!.checkpoint_id,
          taskId,
          taskPath ?? "",
          WRITES_IDX_MAP[channel] ?? idx,
          channel,
          type,
          serialized,
        ] as const
      }),
    )
    const insert = this.db.query(
      `INSERT ${allSpecial ? "OR REPLACE" : "OR IGNORE"} INTO checkpoint_writes
        (thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, value)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.db.transaction(() => {
      for (const row of rows) insert.run(...row)
    })()
  }

  async deleteThread(threadId: string): Promise<void> {
    this.db.transaction(() => {
      this.db.query("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId)
      this.db.query("DELETE FROM checkpoint_blobs WHERE thread_id = ?").run(threadId)
      this.db.query("DELETE FROM checkpoint_writes WHERE thread_id = ?").run(threadId)
    })()
  }

  /** Moves a version 1 to 3 checkpoint's sends from its parent's writes into its channel values. */
  private async migratePendingSends(checkpoint: Checkpoint, threadId: string, parentCheckpointId: string) {
    const sends = sortWrites(
      this.db
        .query<WriteColumn & { value: Uint8Array | null }, [string, string, string]>(
          `SELECT task_id, channel, type, value, task_path, idx FROM checkpoint_writes
            WHERE thread_id = ? AND checkpoint_id = ? AND channel = ?`,
        )
        .all(threadId, parentCheckpointId, TASKS) as unknown as Array<WriteColumn>,
    )
    const mutable = checkpoint as { channel_values: Record<string, unknown>; channel_versions: Checkpoint["channel_versions"] }
    mutable.channel_values ??= {}
    mutable.channel_values[TASKS] = await Promise.all(
      sends.map(({ type, value }) => this.serde.loadsTyped(type ?? "json", value ?? "")),
    )
    mutable.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined)
  }
}
