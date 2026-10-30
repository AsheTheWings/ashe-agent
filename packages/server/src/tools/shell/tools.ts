/*
 * The arguments, descriptions, and result layout follow Codex's
 * `exec_command` and `write_stdin`, codex-rs/core/src/tools/handlers/
 * shell_spec.rs and codex-rs/core/src/tools/context.rs at f32b6cfd2bd.
 * Copyright 2025 OpenAI, licensed under the Apache License, Version 2.0;
 * see LICENSE and NOTICE in this directory.
 */

import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { Effect, Schema } from "effect"
import { builtinTool, type Tool, type ToolResult } from "../../agent/tools.ts"
import { truncateToTokens } from "./output.ts"
import { CommandRefused, type Collected, type ShellProcesses } from "./processes.ts"

export interface ShellToolOptions {
  /** Milliseconds a command runs before it yields, unless its call says otherwise. */
  readonly yieldMs: number
  /** Estimated tokens a result holds, unless its call says otherwise. */
  readonly maxOutputTokens: number
}

const ExecArgs = Schema.Struct({
  cmd: Schema.String.annotate({ description: "Shell command to execute." }),
  workdir: Schema.optionalKey(
    Schema.String.annotate({ description: "Working directory for the command. Defaults to the session directory." }),
  ),
  tty: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "True allocates a PTY for the command; false or omitted uses plain pipes." }),
  ),
  yield_time_ms: Schema.optionalKey(
    Schema.Number.annotate({ description: "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms." }),
  ),
  max_output_tokens: Schema.optionalKey(
    Schema.Number.annotate({ description: "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy." }),
  ),
  login: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "True runs the shell with -l/-i semantics; false disables them. Defaults to true." }),
  ),
})

const WriteArgs = Schema.Struct({
  process_id: Schema.Number.annotate({ description: "Identifier of the running process, from shell_exec_command." }),
  chars: Schema.optionalKey(Schema.String.annotate({ description: "Bytes to write to stdin. Defaults to empty, which polls without writing." })),
  yield_time_ms: Schema.optionalKey(
    Schema.Number.annotate({
      description: "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.",
    }),
  ),
  max_output_tokens: Schema.optionalKey(
    Schema.Number.annotate({ description: "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy." }),
  ),
})

/** A result as Codex lays it out: wall time, exit code or running process, original token count when cut, then output. */
const render = (collected: Collected, maxTokens: number): ToolResult => {
  const { text, originalTokens } = truncateToTokens(collected.output.text(), Math.max(0, Math.floor(maxTokens)))
  const lines = [`Wall time: ${(collected.wallMs / 1000).toFixed(4)} seconds`]
  if (collected.exitCode !== null) lines.push(`Process exited with code ${collected.exitCode}`)
  if (collected.processId !== null) lines.push(`Process running with process_id ${collected.processId}`)
  if (originalTokens !== null) lines.push(`Original token count: ${originalTokens}`)
  lines.push("Output:", text)
  return { outcome: "success", content: lines.join("\n") }
}

const stillRunning = (processId: number) =>
  `Its process keeps running as process_id ${processId}; poll it or write to it with shell_write_stdin.`

/**
 * `shell_exec_command` and `shell_write_stdin`: Codex's unified exec, run
 * as the server's own user without a sandbox. A command is checked under
 * the `shell` permission by its text; writes to its process are covered by
 * that check.
 */
export const shellTools = (processes: ShellProcesses, options: ShellToolOptions): ReadonlyArray<Tool> => [
  builtinTool<typeof ExecArgs, string>({
    namespace: "shell",
    name: "exec_command",
    description: "Runs a command in a PTY or on pipes, returning output or a process_id for ongoing interaction.",
    args: ExecArgs,
    prepare: (args, run) => {
      const cwd = args.workdir === undefined || args.workdir === "" ? run.cwd : resolve(run.cwd, args.workdir)
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        return { outcome: "failed", content: `The working directory ${cwd} does not exist or is not a directory.` }
      }
      return { check: { permission: "shell", subjects: [args.cmd], patterns: [args.cmd] }, plan: cwd }
    },
    run: (args, run, cwd) =>
      Effect.runPromise(
        processes.exec({
          sessionId: run.sessionId,
          command: args.cmd,
          cwd,
          tty: args.tty ?? false,
          login: args.login ?? true,
          yieldMs: args.yield_time_ms ?? options.yieldMs,
          onRunning: (processId) => run.onCancel(stillRunning(processId)),
        }),
        { signal: run.signal },
      ).then(
        (collected) => render(collected, args.max_output_tokens ?? options.maxOutputTokens),
        (error: unknown) => {
          if (error instanceof CommandRefused) return { outcome: "failed", content: error.message } satisfies ToolResult
          throw error
        },
      ),
  }),
  builtinTool({
    namespace: "shell",
    name: "write_stdin",
    description: "Writes characters to a running process from shell_exec_command and returns its recent output.",
    args: WriteArgs,
    run: async (args, run) => {
      run.onCancel(stillRunning(args.process_id))
      const chars = args.chars ?? ""
      const collected = await Effect.runPromise(
        processes.write({ sessionId: run.sessionId, processId: args.process_id, chars, yieldMs: args.yield_time_ms ?? (chars === "" ? 0 : 250) }),
        { signal: run.signal },
      )
      if (collected === null) {
        return {
          outcome: "failed",
          content: `There is no process with process_id ${args.process_id} in this session: it exited and its output was returned, was ended to make room for newer processes, or ended when the server stopped.`,
        }
      }
      return render(collected, args.max_output_tokens ?? options.maxOutputTokens)
    },
  }),
]
