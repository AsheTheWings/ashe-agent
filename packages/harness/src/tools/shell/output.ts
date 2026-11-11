/*
 * The shell module ports the behaviour of Codex's unified exec, from
 * codex-rs/core/src/unified_exec, codex-rs/utils/head-tail-buffer, and
 * codex-rs/utils/string at f32b6cfd2bd. Copyright 2025 OpenAI, licensed
 * under the Apache License, Version 2.0; see LICENSE and NOTICE in this
 * directory.
 */

/** The bytes a process's unread output keeps, and a result's collection keeps, as head and tail. */
export const OUTPUT_MAX_BYTES = 1024 * 1024
const BYTES_PER_TOKEN = 4

/** Estimated tokens of text: its UTF-8 bytes over four, rounded up. */
export const approxTokens = (bytes: number) => Math.ceil(bytes / BYTES_PER_TOKEN)

/** Output kept as the first and last halves of a byte budget, counting what fell between. */
export class HeadTailBuffer {
  private head: Array<Uint8Array> = []
  private headBytes = 0
  private tail: Array<Uint8Array> = []
  private tailBytes = 0
  omitted = 0

  constructor(private readonly maxBytes: number = OUTPUT_MAX_BYTES) {}

  private get headBudget() {
    return Math.floor(this.maxBytes / 2)
  }

  private get tailBudget() {
    return this.maxBytes - this.headBudget
  }

  get retained() {
    return this.headBytes + this.tailBytes
  }

  get empty() {
    return this.retained === 0 && this.omitted === 0
  }

  push(chunk: Uint8Array) {
    const room = this.headBudget - this.headBytes
    if (room > 0) {
      const into = chunk.subarray(0, room)
      this.head.push(into)
      this.headBytes += into.length
      chunk = chunk.subarray(into.length)
    }
    if (chunk.length === 0) return
    if (chunk.length >= this.tailBudget) {
      this.omitted += this.tailBytes + chunk.length - this.tailBudget
      this.tail = [chunk.slice(chunk.length - this.tailBudget)]
      this.tailBytes = this.tailBudget
      return
    }
    this.tail.push(chunk)
    this.tailBytes += chunk.length
    while (this.tailBytes > this.tailBudget) {
      const excess = this.tailBytes - this.tailBudget
      const first = this.tail[0]!
      if (first.length <= excess) {
        this.tail.shift()
        this.tailBytes -= first.length
        this.omitted += first.length
      } else {
        this.tail[0] = first.subarray(excess)
        this.tailBytes -= excess
        this.omitted += excess
      }
    }
  }

  /** Moves everything `other` holds into this buffer, emptying `other`. */
  take(other: HeadTailBuffer) {
    this.omitted += other.omitted
    for (const chunk of [...other.head, ...other.tail]) this.push(chunk)
    // Bytes `other` omitted sat between its head and tail; pushing both keeps their order.
    other.head = []
    other.tail = []
    other.headBytes = 0
    other.tailBytes = 0
    other.omitted = 0
  }

  /** The kept text, with a marker where bytes were omitted. */
  text(): string {
    const decoder = new TextDecoder()
    const join = (chunks: ReadonlyArray<Uint8Array>) => {
      const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      return decoder.decode(bytes)
    }
    if (this.omitted === 0) return join([...this.head, ...this.tail])
    return `${join(this.head)}\n${omissionMarker(this.omitted)}\n${join(this.tail)}`
  }
}

export const omissionMarker = (bytes: number) => `... ${bytes} bytes omitted ...`

const encoder = new TextEncoder()

/**
 * Text cut to `maxTokens` estimated tokens as its head and tail around a
 * marker counting the tokens removed, never inside a character; with a
 * warning naming the original token count when anything was cut.
 */
export const truncateToTokens = (text: string, maxTokens: number): { text: string; originalTokens: number | null } => {
  const bytes = encoder.encode(text)
  const budget = maxTokens * BYTES_PER_TOKEN
  if (bytes.length <= budget) return { text, originalTokens: null }
  const left = Math.floor(budget / 2)
  const right = budget - left
  // Step back to character boundaries: a UTF-8 continuation byte is 10xxxxxx.
  let headEnd = left
  while (headEnd > 0 && (bytes[headEnd]! & 0xc0) === 0x80) headEnd -= 1
  let tailStart = bytes.length - right
  while (tailStart < bytes.length && (bytes[tailStart]! & 0xc0) === 0x80) tailStart += 1
  const decoder = new TextDecoder()
  const removed = approxTokens(bytes.length - budget)
  const originalTokens = approxTokens(bytes.length)
  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
  return {
    text: `Warning: truncated output (original token count: ${originalTokens})\nTotal output lines: ${lines}\n\n${decoder.decode(bytes.subarray(0, headEnd))}…${removed} tokens truncated…${decoder.decode(bytes.subarray(tailStart))}`,
    originalTokens,
  }
}
