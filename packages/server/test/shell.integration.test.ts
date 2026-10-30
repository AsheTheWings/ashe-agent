import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionEvent } from "@ashe-agent/protocol"
import type { Tool, ToolRun } from "../src/agent/tools.ts"
import type { Permission } from "../src/inputs/shapes.ts"
import { holderScript, LeftGroup } from "../src/tools/shell/groups.ts"
import { ShellProcesses, shellTools } from "../src/tools/shell/index.ts"
import { waitFor } from "./support/cli.ts"
import { AgentHarness, callTools, gate, hold, say } from "./support/agent.ts"

const options = { yieldMs: 10_000, maxOutputTokens: 10_000 }

const withShell = async (
  config: { maxProcesses?: number; envFile?: string; permission?: Permission; home?: Record<string, string> },
  body: (h: AgentHarness, processes: ShellProcesses, tool: (name: string) => Tool, envFile: string | null) => Promise<void>,
) => {
  const scripts = mkdtempSync(join(tmpdir(), "ashe-agent-shell-"))
  let envFile: string | null = null
  if (config.envFile !== undefined) {
    envFile = join(scripts, "env.sh")
    writeFileSync(envFile, config.envFile)
  }
  for (const [name, content] of Object.entries(config.home ?? {})) writeFileSync(join(scripts, name), content)
  const processes = new ShellProcesses({
    shell: "/bin/bash",
    envFile,
    env: { PATH: process.env.PATH, HOME: scripts },
    maxProcesses: config.maxProcesses ?? 64,
  })
  const tools = shellTools(processes, options)
  const harness = new AgentHarness({ tools, ...(config.permission === undefined ? {} : { permission: config.permission }) })
  try {
    await body(harness, processes, (name) => tools.find((candidate) => candidate.spec.name === name)!, envFile)
  } finally {
    processes.stopAll()
    await harness.cleanup()
    rmSync(scripts, { recursive: true, force: true })
  }
}

/** Calls a shell tool directly, as a turn of `sessionId` would. */
const call = (tool: Tool, cwd: string, sessionId: string, args: unknown) => {
  const run: ToolRun = {
    sessionId,
    runId: "r",
    toolCallId: crypto.randomUUID(),
    cwd,
    imageInput: false,
    signal: new AbortController().signal,
    authorize: async () => {},
    started: () => {},
    onCancel: () => {},
  }
  return tool.run(args, run).then((result) => result.content as string)
}

const processId = (text: string) => Number(/Process running with process_id (\d+)/.exec(text)?.[1])
const output = (text: string) => text.slice(text.indexOf("Output:\n") + "Output:\n".length)
const ofType = (events: ReadonlyArray<SessionEvent>, type: string) =>
  (events.map((event) => event.event) as Array<any>).filter((event) => event.type === type)

describe("shell processes", () => {
  test("the `shell` permission decides a command by its text, and writes to its process are not asked", async () => {
    await withShell({ permission: { shell: { "*": "ask", "rm *": "deny" } } }, async (h, processes) => {
      const id = h.create()
      h.model.next(
        callTools([
          { name: "shell_exec_command", args: { cmd: "rm -rf nothing-here" } },
          { name: "shell_exec_command", args: { cmd: "read line; echo got:$line", yield_time_ms: 250 } },
        ]),
      )
      h.input(id, "run")
      const request = await waitFor("the shell request", () => ofType(h.events(id), "PERMISSION_REQUESTED")[0])
      expect(request).toMatchObject({ permission: "shell", subjects: ["read line; echo got:$line"], patterns: ["read line; echo got:$line"] })
      expect(ofType(h.events(id), "TOOL_CALL_RESULT")[0]).toMatchObject({ outcome: "failed", content: expect.stringContaining("denied by configuration") })
      h.model.next(say("waiting"))
      h.answer(id, request.requestId, "once")
      await h.turnsEnded(id, 1)
      const [process] = processes.ids(id)
      h.model.next(callTools([{ name: "shell_write_stdin", args: { process_id: process, chars: "hi\n", yield_time_ms: 2_000 } }]), say("done"))
      h.input(id, "answer it")
      await h.turnsEnded(id, 2)
      expect(ofType(h.events(id), "PERMISSION_REQUESTED")).toHaveLength(1)
      expect(ofType(h.events(id), "TOOL_CALL_RESULT").at(-1).content).toContain("got:hi")
    })
  }, 30_000)

  test("a command does not run when its env file is unreadable or fails to source", async () => {
    const cases = [
      { content: "export A=1\n", mode: 0o000, result: (envFile: string) => `The command did not run: the shell env file ${envFile} is not readable.` },
      { content: "if then fi\n", mode: 0o600, result: () => expect.stringMatching(/^Wall time: .*\nProcess exited with code 126\nOutput:\n/) },
      { content: "export A=1\nfalse\n", mode: 0o600, result: () => expect.stringContaining("Process exited with code 126") },
    ]
    for (const { content, mode, result } of cases) {
      await withShell({ envFile: content }, async (h, processes, tool, envFile) => {
        chmodSync(envFile!, mode)
        const marker = join(h.dir, "ran")
        const text = await call(tool("shell_exec_command"), h.dir, "s", { cmd: `touch ${marker}` })
        expect(text).toEqual(result(envFile!))
        if (mode !== 0o000) expect(text).toContain(`The command did not run: sourcing the shell env file ${envFile} returned status`)
        expect(existsSync(marker)).toBe(false)
        expect(processes.ids("s")).toEqual([])
      })
    }
  }, 30_000)

  test("the env file is sourced after login startup, which may set parser options", async () => {
    await withShell(
      { envFile: "case foo in @(foo|bar)) export OK=yes;; esac\n", home: { ".bash_profile": "shopt -s extglob\n" } },
      async (h, _processes, tool) => {
        expect(output(await call(tool("shell_exec_command"), h.dir, "s", { cmd: "echo OK=$OK" }))).toBe("OK=yes\n")
      },
    )
  }, 30_000)

  test("a command runs in its workdir, else the starting directory, after the env file, and ends with its exit code", async () => {
    await withShell({ envFile: "export GREETING=sourced\n" }, async (h, _processes, tool) => {
      const exec = tool("shell_exec_command")
      mkdirSync(join(h.dir, "sub"))
      const root = realpathSync(h.dir)
      expect(output(await call(exec, h.dir, "s", { cmd: "pwd" }))).toBe(`${root}\n`)
      expect(output(await call(exec, h.dir, "s", { cmd: "pwd", workdir: "sub" }))).toBe(`${root}/sub\n`)
      expect(output(await call(exec, h.dir, "s", { cmd: "echo $GREETING", login: false }))).toBe("sourced\n")
      const failed = await call(exec, h.dir, "s", { cmd: "echo out; echo err >&2; exit 3" })
      expect(failed).toMatch(/^Wall time: \d+\.\d{4} seconds\nProcess exited with code 3\nOutput:\n/)
      expect(output(failed).split("\n").sort()).toEqual(["", "err", "out"])
      expect(await call(exec, h.dir, "s", { cmd: "pwd", workdir: "missing" })).toBe(`The working directory ${join(h.dir, "missing")} does not exist or is not a directory.`)
    })
  }, 30_000)

  test("a long command yields a process_id; a write, an empty poll, and \\u0003 reach it", async () => {
    await withShell({}, async (h, processes, tool) => {
      const started = await call(tool("shell_exec_command"), h.dir, "s", {
        cmd: "echo ready; read line; echo got:$line; sleep 60",
        yield_time_ms: 250,
      })
      expect(output(started)).toBe("ready\n")
      const id = processId(started)
      expect(processes.ids("s")).toEqual([id])
      const write = tool("shell_write_stdin")
      const answered = await call(write, h.dir, "s", { process_id: id, chars: "hello\n", yield_time_ms: 1_000 })
      expect(output(answered)).toBe("got:hello\n")
      expect(processId(answered)).toBe(id)
      const polled = await call(write, h.dir, "s", { process_id: id })
      expect(polled).toMatch(/^Wall time: (5|6)\.\d{4} seconds\nProcess running with process_id \d+\nOutput:\n$/)
      const interrupted = await call(write, h.dir, "s", { process_id: id, chars: "\u0003", yield_time_ms: 5_000 })
      expect(interrupted).toMatch(/Process exited with code \d+/)
      expect(processes.ids("s")).toEqual([])
    })
  }, 30_000)

  test("a PTY command reads a written line", async () => {
    await withShell({}, async (h, _processes, tool) => {
      const started = await call(tool("shell_exec_command"), h.dir, "s", { cmd: "read line; echo got:$line", tty: true, yield_time_ms: 500 })
      const answered = await call(tool("shell_write_stdin"), h.dir, "s", { process_id: processId(started), chars: "abc\n", yield_time_ms: 2_000 })
      expect(answered).toContain("Process exited with code 0")
      expect(output(answered)).toContain("got:abc")
    })
  }, 30_000)
})

describe("shell limits", () => {
  test("endless output is kept as head and tail within the token budget and 1 MiB", async () => {
    await withShell({}, async (h, _processes, tool) => {
      const started = await call(tool("shell_exec_command"), h.dir, "s", { cmd: "yes 0123456789", yield_time_ms: 1_000, max_output_tokens: 100 })
      expect(started).toMatch(/Original token count: \d+\nOutput:\nWarning: truncated output/)
      const kept = output(started)
      expect(kept).toMatch(/…\d+ tokens truncated…/)
      expect(kept.slice(kept.indexOf("\n\n") + 2).replace(/…\d+ tokens truncated…/, "").length).toBeLessThanOrEqual(400)
      const id = processId(started)
      const later = await call(tool("shell_write_stdin"), h.dir, "s", { process_id: id, chars: "", yield_time_ms: 5_000, max_output_tokens: 1_000_000 })
      const unread = output(later)
      expect(unread).toMatch(/\.\.\. \d+ bytes omitted \.\.\./)
      expect(new TextEncoder().encode(unread).length).toBeLessThanOrEqual(1024 * 1024 + 100)
      await call(tool("shell_write_stdin"), h.dir, "s", { process_id: id, chars: "\u0003" })
    })
  }, 30_000)

  test("starting a process at the limit ends the least recently used one past the eight newest, preferring an exited one", async () => {
    await withShell({ maxProcesses: 10 }, async (h, processes, tool) => {
      const exec = tool("shell_exec_command")
      const start = async (cmd: string) => processId(await call(exec, h.dir, "s", { cmd, yield_time_ms: 250 }))
      const first = await start("sleep 60")
      const second = await start("sleep 1")
      const third = await start("sleep 60")
      const newest: Array<number> = []
      for (let i = 0; i < 7; i += 1) newest.push(await start("sleep 60"))
      await waitFor("the second process to exit", () => (processes.state("s", second) === "exited" ? true : undefined), 5_000)
      newest.push(await start("sleep 60"))
      expect(processes.ids("s")).not.toContain(second)
      expect(processes.ids("s")).toContain(first)
      newest.push(await start("sleep 60"))
      expect([...processes.ids("s")].sort()).toEqual([third, ...newest].sort())
      expect(await call(tool("shell_write_stdin"), h.dir, "s", { process_id: first, chars: "x" })).toStartWith(`There is no process with process_id ${first} in this session`)
    })
  }, 30_000)

  test("a cancel after output arrived keeps that output for the next result", async () => {
    await withShell({}, async (h, processes) => {
      const id = h.create()
      h.model.next(callTools([{ name: "shell_exec_command", args: { cmd: "echo started; sleep 60", yield_time_ms: 30_000 } }]))
      h.input(id, "run")
      const process = await waitFor("the process's output", () => {
        const [candidate] = processes.ids(id)
        return candidate !== undefined && (processes.unreadBytes(id, candidate) ?? 0) > 0 ? candidate : undefined
      })
      h.hub.cancel(id)
      await h.turnsEnded(id, 1)
      h.model.next(callTools([{ name: "shell_write_stdin", args: { process_id: process, chars: "", yield_time_ms: 5_000 } }]), say("polled"))
      h.input(id, "poll")
      await h.turnsEnded(id, 2)
      expect(ofType(h.events(id), "TOOL_CALL_RESULT")[1].content).toEndWith(`Process running with process_id ${process}\nOutput:\nstarted\n`)
    })
  }, 30_000)

  test("a cancel ends the waiting call and leaves its process running and addressable", async () => {
    await withShell({}, async (h, processes) => {
      const id = h.create()
      h.model.next(callTools([{ name: "shell_exec_command", args: { cmd: "echo started; sleep 60", yield_time_ms: 30_000 } }]))
      h.input(id, "run")
      await waitFor("the process", () => (processes.ids(id).length === 1 ? true : undefined))
      h.hub.cancel(id)
      await h.turnsEnded(id, 1)
      const [process] = processes.ids(id)
      const result = ofType(h.events(id), "TOOL_CALL_RESULT")[0]
      expect(result).toMatchObject({ outcome: "canceled" })
      expect(result.content).toBe(
        `The tool call was canceled after it started; it may have had effects. Its process keeps running as process_id ${process}; poll it or write to it with shell_write_stdin.`,
      )
      h.model.next(callTools([{ name: "shell_write_stdin", args: { process_id: process, chars: "", yield_time_ms: 5_000 } }]), say("polled"))
      h.input(id, "poll")
      await h.turnsEnded(id, 2)
      expect(ofType(h.events(id), "TOOL_CALL_RESULT")[1].content).toContain(`Process running with process_id ${process}\nOutput:\nstarted\n`)
    })
  }, 30_000)

  test("a server stop ends every process and what exited commands left running, and a write to a gone process_id says so", async () => {
    await withShell({}, async (h, processes, tool) => {
      const started = await call(tool("shell_exec_command"), h.dir, "s", { cmd: "echo $$; sleep 60", yield_time_ms: 500 })
      const pid = Number(output(started).trim())
      const left = await call(tool("shell_exec_command"), h.dir, "s", { cmd: "sleep 60 >/dev/null 2>&1 & echo $!" })
      expect(left).toContain("Process exited with code 0")
      const child = Number(output(left).trim())
      const alive = async (target: number) => (await Bun.$`kill -0 ${target}`.nothrow().quiet()).exitCode === 0
      expect(await alive(child)).toBe(true)
      processes.stopAll()
      await waitFor("the process to end", async () => (!(await alive(pid)) ? true : undefined), 5_000)
      await waitFor("the background child to end", async () => (!(await alive(child)) ? true : undefined), 5_000)
      expect(await call(tool("shell_write_stdin"), h.dir, "s", { process_id: processId(started) })).toStartWith(
        `There is no process with process_id ${processId(started)} in this session`,
      )
    })
  }, 30_000)
})

describe("shell processes after a history change", () => {
  test("a rewind leaves a session's process addressable, and a fork starts with none", async () => {
    await withShell({}, async (h, processes) => {
      const id = h.create()
      h.model.next(callTools([{ name: "shell_exec_command", args: { cmd: "echo up; sleep 60", yield_time_ms: 250 } }]), say("started"))
      h.input(id, "start")
      await h.turnsEnded(id, 1)
      const [process] = processes.ids(id)
      expect(process).toBeNumber()
      if (process === undefined) throw new Error("no process")
      h.model.next(say("second"))
      h.input(id, "second")
      await h.turnsEnded(id, 2)
      const second = ofType(h.events(id), "RUN_STARTED").at(-1).runId
      const open = gate()
      h.model.next(hold(open.promise, callTools([{ name: "shell_write_stdin", args: { process_id: process, chars: "", yield_time_ms: 5_000 } }])), say("polled"))
      h.hub.rewind(id, second, "poll it", h.sender)
      open.open()
      await waitFor("the rerun", () => (ofType(h.events(id), "RUN_FINISHED").length === 2 && !h.hub.isRunning(id) ? true : undefined), 15_000)
      expect(processes.ids(id)).toEqual([process])
      expect(ofType(h.events(id), "TOOL_CALL_RESULT").at(-1).content).toContain(`Process running with process_id ${process}`)
      const fork = h.hub.fork(id, undefined).id
      expect(processes.ids(fork)).toEqual([])
      h.model.next(callTools([{ name: "shell_write_stdin", args: { process_id: process, chars: "" } }]), say("none"))
      h.input(fork, "poll in the fork")
      await waitFor("the fork's turn", () => (!h.hub.isRunning(fork) && ofType(h.events(fork), "RUN_FINISHED").length >= 3 ? true : undefined), 15_000)
      expect(ofType(h.events(fork), "TOOL_CALL_RESULT").at(-1).content).toStartWith(`There is no process with process_id ${process} in this session`)
    })
  }, 30_000)
})

describe("process groups left by exited commands", () => {
  test("a grandchild started after its parent's exit is ended at stop", async () => {
    await withShell({}, async (h, processes, tool) => {
      const marker = join(h.dir, "grandchild")
      const started = await call(tool("shell_exec_command"), h.dir, "s", {
        cmd: `(sleep 0.5; sleep 60 </dev/null >/dev/null 2>&1 & echo $! > ${marker}) </dev/null >/dev/null 2>&1 &`,
        yield_time_ms: 1_000,
      })
      expect(started).toContain("Process exited with code 0")
      const grandchild = await waitFor("the grandchild", () => (existsSync(marker) && readFileSync(marker, "utf8").trim() !== "" ? Number(readFileSync(marker, "utf8")) : undefined))
      const alive = async (target: number) => (await Bun.$`kill -0 ${target}`.nothrow().quiet()).exitCode === 0
      const parentOf = (pid: number) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[1])
      const parent = parentOf(grandchild)
      await waitFor("the grandchild's parent to exit", async () => (!(await alive(parent)) ? true : undefined))
      expect(await alive(grandchild)).toBe(true)
      processes.stopAll()
      await waitFor("the grandchild to end", async () => (!(await alive(grandchild)) ? true : undefined), 5_000)
    })
  }, 30_000)

  test("a group left holding only its holder is ended, so a finished command leaves no process", async () => {
    await withShell({}, async (h, processes, tool) => {
      const token = crypto.randomUUID()
      const leader = Bun.spawn(["/bin/sh", "-c", `${holderScript(token)}\nexec sleep 60`], { detached: true, stdio: ["ignore", "ignore", "ignore"] })
      try {
        const holderOf = async () => (await Bun.$`pgrep -g ${leader.pid} -f 2147483647`.nothrow().quiet()).stdout.toString().trim()
        await waitFor("the holder", async () => ((await holderOf()) !== "" ? true : undefined))
        leader.kill("SIGKILL")
        await leader.exited
        const group = LeftGroup.of(leader.pid, token)
        expect(group).toBeNull()
        expect(await holderOf()).toBe("")
      } finally {
        try {
          process.kill(-leader.pid, "SIGKILL")
        } catch {}
      }
      const done = await call(tool("shell_exec_command"), h.dir, "s", { cmd: "echo $$" })
      const pid = Number(output(done).trim())
      await waitFor("the command's group to empty", async () => ((await Bun.$`pgrep -g ${pid}`.nothrow().quiet()).stdout.toString().trim() === "" ? true : undefined))
      expect(processes.ids("s")).toEqual([])
    })
  }, 30_000)
})
