/*
 * Ports the process handling of Codex's unified exec,
 * codex-rs/core/src/unified_exec/process_manager.rs at f32b6cfd2bd.
 * Copyright 2025 OpenAI, licensed under the Apache License, Version 2.0;
 * see LICENSE and NOTICE in this directory.
 */

import { accessSync, constants, statSync } from "node:fs"
import { Effect, Semaphore } from "effect"
import { holderScript, LeftGroup } from "./groups.ts"
import { HeadTailBuffer } from "./output.ts"

/** Bounds of a command's yield, a write's wait, and an empty poll's wait, in milliseconds. */
export const MIN_YIELD_MS = 250
export const MAX_YIELD_MS = 30_000
export const MIN_EMPTY_POLL_MS = 5_000
export const MAX_EMPTY_POLL_MS = 300_000
/** How long output may still arrive after a process exits. */
const POST_EXIT_CLOSE_MS = 50
/** The most recently used processes pruning spares, as Codex does, while the limit leaves room for one more. */
const PROTECTED_RECENT = 8

export interface ShellConfig {
  /** The server user's login shell. */
  readonly shell: string
  /** A script sourced before every command, or null. */
  readonly envFile: string | null
  /** The environment commands start with. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The processes a session holds at most. */
  readonly maxProcesses: number
}

interface Running {
  readonly id: number
  readonly sessionId: string
  readonly tty: boolean
  readonly proc: Bun.Subprocess
  /** Output no result has returned yet. */
  readonly pending: HeadTailBuffer
  readonly listeners: Set<() => void>
  exitCode: number | null
  /** What the command left running in its process group when it exited, or null. */
  left: LeftGroup | null
  closed: boolean
  lastUsed: number
  /** Serializes writes and polls, and keeps pruning away while one runs. */
  readonly lock: Semaphore.Semaphore
  /** Calls collecting the process's output now. */
  busy: number
}

/** What a command or write returns: output since the last result, and an exit code or a still running process. */
export interface Collected {
  readonly output: HeadTailBuffer
  readonly exitCode: number | null
  readonly processId: number | null
  readonly wallMs: number
}

/** A command refused before it started, with the reason the model receives. */
export class CommandRefused extends Error {
  readonly _tag = "CommandRefused"
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/**
 * The shell processes of every session. A command runs in its own process
 * group, so ending it ends what it started; a process outlives the call
 * that started it until it exits, is pruned, or the server stops. The
 * groups of exited commands that still hold processes are kept, by their
 * holders, until stop, since what a command started in the background
 * outlives it.
 */
export class ShellProcesses {
  private readonly sessions = new Map<string, Map<number, Running>>()
  /** Process groups whose leader exited and was dropped while they still held processes. */
  private readonly groups = new Set<LeftGroup>()
  private stopped = false

  constructor(private readonly config: ShellConfig) {}

  private of(sessionId: string) {
    let processes = this.sessions.get(sessionId)
    if (processes === undefined) {
      processes = new Map()
      this.sessions.set(sessionId, processes)
    }
    return processes
  }

  /** The process ids a session holds. */
  ids(sessionId: string): ReadonlyArray<number> {
    return [...(this.sessions.get(sessionId)?.keys() ?? [])]
  }

  /** The bytes of a session's process output that no result has returned yet, or null when the session holds no such process. */
  unreadBytes(sessionId: string, processId: number): number | null {
    const process = this.sessions.get(sessionId)?.get(processId)
    return process === undefined ? null : process.pending.retained + process.pending.omitted
  }

  /** Whether a session's process is running or has exited with output not yet returned, or null when the session holds no such process. */
  state(sessionId: string, processId: number): "running" | "exited" | null {
    const process = this.sessions.get(sessionId)?.get(processId)
    return process === undefined ? null : process.exitCode === null ? "running" : "exited"
  }

  private notify(process: Running) {
    for (const listener of [...process.listeners]) listener()
  }

  private allocate(processes: Map<number, Running>) {
    for (;;) {
      const id = 1_000 + Math.floor(Math.random() * 99_000)
      if (!processes.has(id)) return id
    }
  }

  /**
   * Ends the session's least recently used process, preferring exited ones,
   * when the session is at its limit. The eight most recently used are
   * spared, or all but one under a smaller limit; a process a call is
   * collecting from is never ended.
   */
  private prune(processes: Map<number, Running>) {
    while (processes.size >= this.config.maxProcesses) {
      const byAge = [...processes.values()].sort((a, b) => a.lastUsed - b.lastUsed)
      const spared = Math.min(PROTECTED_RECENT, this.config.maxProcesses - 1)
      const free = byAge.slice(0, Math.max(0, byAge.length - spared)).filter((process) => process.busy === 0)
      const victim = free.find((process) => process.exitCode !== null) ?? free[0]
      if (victim === undefined) return
      this.end(victim)
      processes.delete(victim.id)
    }
  }

  /**
   * Ends a process and everything in its group: by the group id while the
   * leader runs, else only while the group it left is still that group.
   */
  private end(process: Running) {
    if (process.exitCode === null) {
      try {
        globalThis.process.kill(-process.proc.pid, "SIGKILL")
      } catch {
        process.proc.kill("SIGKILL")
      }
    } else process.left?.kill()
    process.proc.terminal?.close()
  }

  /** Forgets the kept groups whose holder is gone, and ends those holding nothing but their holder. */
  private sweepGroups() {
    for (const group of this.groups) {
      if (group.idle()) group.kill()
      if (!group.live()) this.groups.delete(group)
    }
  }

  /** Why the configured env file cannot be sourced, or null when it is a readable file. */
  private envFileProblem(envFile: string): string | null {
    try {
      if (!statSync(envFile).isFile()) return "is not a file"
      accessSync(envFile, constants.R_OK)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "does not exist" : "is not readable"
    }
    return null
  }

  private spawn(sessionId: string, command: string, cwd: string, tty: boolean, login: boolean): Running {
    const processes = this.of(sessionId)
    this.prune(processes)
    this.sweepGroups()
    // The env file is sourced in the command's own shell, so login startup applies to it; any failure stops the command.
    const envFile = this.config.envFile
    const script =
      envFile === null
        ? command
        : `. ${quote(envFile)} || { __ashe_status=$?; printf '%s\\n' ${quote(`The command did not run: sourcing the shell env file ${envFile} returned status`)}" $__ashe_status." >&2; exit 126; }\n${command}`
    // A POSIX shell starts the group's holder, then becomes the command's shell, keeping its process id.
    const token = crypto.randomUUID()
    const argv = ["/bin/sh", "-c", `${holderScript(token)}\nexec ${quote(this.config.shell)} ${login ? "-lc" : "-c"} ${quote(script)}`]
    const pending = new HeadTailBuffer()
    const listeners = new Set<() => void>()
    const entry = {
      id: this.allocate(processes),
      sessionId,
      tty,
      pending,
      listeners,
      exitCode: null as number | null,
      left: null as LeftGroup | null,
      closed: false,
      lastUsed: performance.now(),
      lock: Semaphore.makeUnsafe(1),
      busy: 0,
    }
    const push = (bytes: Uint8Array) => {
      pending.push(bytes.slice())
      for (const listener of [...listeners]) listener()
    }
    const env = { ...this.config.env } as Record<string, string>
    let proc: Bun.Subprocess
    if (tty) {
      proc = Bun.spawn(argv, {
        cwd,
        env: { TERM: "xterm-256color", ...env },
        detached: true,
        terminal: {
          cols: 120,
          rows: 40,
          data: (_terminal, data) => push(data),
          exit: () => {
            running.closed = true
            this.notify(running)
          },
        },
      })
    } else {
      proc = Bun.spawn(argv, { cwd, env, detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
      const drain = async (stream: ReadableStream<Uint8Array>) => {
        for await (const chunk of stream) push(chunk)
      }
      Promise.all([drain(proc.stdout as ReadableStream<Uint8Array>), drain(proc.stderr as ReadableStream<Uint8Array>)]).finally(() => {
        running.closed = true
        this.notify(running)
      })
    }
    const running: Running = { ...entry, proc }
    proc.exited.then((code) => {
      running.left = LeftGroup.of(proc.pid, token)
      running.exitCode = code
      this.notify(running)
    })
    processes.set(running.id, running)
    return running
  }

  /** Waits until `process` has new output, has exited and closed its output, or `until` passes. */
  private wait(process: Running, until: number) {
    return Effect.callback<void>((resume) => {
      const done = () => {
        process.listeners.delete(done)
        clearTimeout(timer)
        resume(Effect.void)
      }
      const timer = setTimeout(done, Math.max(0, until - performance.now()))
      process.listeners.add(done)
      return Effect.sync(() => {
        process.listeners.delete(done)
        clearTimeout(timer)
      })
    })
  }

  /**
   * Collects output until the process exits and its output closes, or the
   * deadline passes; output arriving just after an exit is waited for
   * briefly. A process that ended is dropped from its session.
   */
  private collect(process: Running, started: number, deadline: number) {
    const self = this
    const collecting = Effect.gen(function* () {
      let postExit: number | null = null
      // Output stays in `pending` while waiting, so an interrupted call loses none of it.
      for (;;) {
        const now = performance.now()
        if (process.exitCode !== null && process.closed) break
        if (now >= deadline) break
        if (process.exitCode !== null) {
          postExit ??= Math.min(deadline, now + POST_EXIT_CLOSE_MS)
          if (now >= postExit) break
          yield* self.wait(process, postExit)
          continue
        }
        yield* self.wait(process, deadline)
      }
      const output = new HeadTailBuffer()
      output.take(process.pending)
      process.lastUsed = performance.now()
      const exited = process.exitCode !== null
      if (exited) {
        process.proc.terminal?.close()
        self.sessions.get(process.sessionId)?.delete(process.id)
        if (process.left !== null) self.groups.add(process.left)
      }
      return { output, exitCode: process.exitCode, processId: exited ? null : process.id, wallMs: performance.now() - started } satisfies Collected
    })
    return Effect.acquireUseRelease(
      Effect.sync(() => (process.busy += 1)),
      () => collecting,
      () => Effect.sync(() => (process.busy -= 1)),
    )
  }

  /**
   * Runs `command` in a new process of the login shell, in `cwd`, and
   * returns at its exit or after `yieldMs`, clamped to 250 to 30,000 ms.
   * `onRunning` receives the process id as soon as the process exists.
   */
  exec(options: {
    readonly sessionId: string
    readonly command: string
    readonly cwd: string
    readonly tty: boolean
    readonly login: boolean
    readonly yieldMs: number
    readonly onRunning?: (processId: number) => void
  }): Effect.Effect<Collected, CommandRefused> {
    const self = this
    return Effect.gen(function* () {
      if (self.stopped) return yield* Effect.fail(new CommandRefused("The command did not run: the server is stopping."))
      const envFile = self.config.envFile
      const problem = envFile === null ? null : self.envFileProblem(envFile)
      if (problem !== null) return yield* Effect.fail(new CommandRefused(`The command did not run: the shell env file ${envFile} ${problem}.`))
      const started = performance.now()
      const process = self.spawn(options.sessionId, options.command, options.cwd, options.tty, options.login)
      options.onRunning?.(process.id)
      const yieldMs = Math.min(Math.max(options.yieldMs, MIN_YIELD_MS), MAX_YIELD_MS)
      return yield* process.lock.withPermits(1)(self.collect(process, started, started + yieldMs))
    })
  }

  /**
   * Writes `chars` to a session's process and collects its output: 250 ms
   * by default after a write, at most 30,000 ms; 5,000 to 300,000 ms for an
   * empty poll. A `\u0003` interrupts the process: through the PTY's line
   * discipline with a terminal, as SIGINT to its process group without one.
   * Returns null when the session holds no such process.
   */
  write(options: { readonly sessionId: string; readonly processId: number; readonly chars: string; readonly yieldMs: number }): Effect.Effect<Collected | null> {
    const self = this
    return Effect.gen(function* () {
      const process = self.sessions.get(options.sessionId)?.get(options.processId)
      if (process === undefined) return null
      return yield* process.lock.withPermits(1)(
        Effect.gen(function* () {
          const started = performance.now()
          if (options.chars !== "") self.send(process, options.chars)
          const floor = Math.max(options.yieldMs, MIN_YIELD_MS)
          const waitMs = options.chars === "" ? Math.min(Math.max(floor, MIN_EMPTY_POLL_MS), MAX_EMPTY_POLL_MS) : Math.min(floor, MAX_YIELD_MS)
          return yield* self.collect(process, started, started + waitMs)
        }),
      )
    })
  }

  private send(process: Running, chars: string) {
    if (process.exitCode !== null) return
    if (process.tty) {
      process.proc.terminal!.write(chars)
      return
    }
    const text = chars.replaceAll("\u0003", "")
    if (text !== "") {
      const stdin = process.proc.stdin as import("bun").FileSink
      stdin.write(text)
      stdin.flush()
    }
    if (chars.includes("\u0003")) {
      try {
        globalThis.process.kill(-process.proc.pid, "SIGINT")
      } catch {
        process.proc.kill("SIGINT")
      }
    }
  }

  /** Ends every process of every session; later commands are refused. */
  stopAll() {
    this.stopped = true
    for (const processes of this.sessions.values()) {
      for (const process of processes.values()) this.end(process)
      processes.clear()
    }
    for (const group of this.groups) group.kill()
    this.groups.clear()
  }
}
