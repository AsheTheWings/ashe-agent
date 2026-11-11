import { readdirSync, readFileSync } from "node:fs"

/** The variable that marks a command's holder process, with a value unique to the command. */
export const HOLDER_VARIABLE = "ASHE_AGENT_GROUP_HOLDER"

/** A process by its id and its start time since boot, which together tell it from a later process reusing the id. */
interface Member {
  readonly pid: number
  readonly start: string
}

interface Stat {
  readonly pgrp: number
  readonly start: string
}

/** A process's group and start time from `/proc/<pid>/stat`, or null when it is gone or unreadable. */
const stat = (pid: number): Stat | null => {
  let text: string
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch {
    return null
  }
  // The command name may hold spaces and parentheses; the fields after its last `)` start at the state.
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ")
  const pgrp = Number(fields[2])
  const start = fields[19]
  return Number.isInteger(pgrp) && start !== undefined ? { pgrp, start } : null
}

/** The processes in group `pgid` now. */
const members = (pgid: number): ReadonlyArray<Member> => {
  let entries: Array<string>
  try {
    entries = readdirSync("/proc")
  } catch {
    return []
  }
  const found: Array<Member> = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    const info = stat(pid)
    if (info !== null && info.pgrp === pgid) found.push({ pid, start: info.start })
  }
  return found
}

const holds = (pid: number, marker: string) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(marker)
  } catch {
    return false
  }
}

/**
 * The shell script that starts a command's holder: a process in the
 * command's group, detached from its shell's jobs and output and ignoring
 * terminal and interrupt signals, that keeps the group id taken until the
 * server ends it. The kernel never reuses an id that a live process
 * holds as its group, so while the holder lives the group id names the
 * command's group, whatever the command started there and whenever.
 */
export const holderScript = (token: string) =>
  `( ( trap '' HUP INT QUIT TERM TSTP; ${HOLDER_VARIABLE}=${token} exec sleep 2147483647 ) </dev/null >/dev/null 2>&1 & )`

/**
 * The process group of a command whose leader exited, known by its
 * holder. It is signaled only while that holder still runs in it.
 */
export class LeftGroup {
  private constructor(
    readonly pgid: number,
    private readonly holder: Member,
  ) {}

  /**
   * Finds the holder of group `pgid` by its `token`. When the holder is the
   * group's last process, the group is ended and null returned; null too
   * when no holder is found.
   */
  static of(pgid: number, token: string): LeftGroup | null {
    const found = members(pgid)
    const marker = `${HOLDER_VARIABLE}=${token}`
    const holder = found.find((member) => holds(member.pid, marker))
    if (holder === undefined) return null
    const group = new LeftGroup(pgid, holder)
    if (found.length === 1) {
      group.kill()
      return null
    }
    return group
  }

  /** Whether the holder still runs in the group, so the group id still names the command's group. */
  live(): boolean {
    const info = stat(this.holder.pid)
    return info !== null && info.pgrp === this.pgid && info.start === this.holder.start
  }

  /** Whether the group holds nothing but its holder. */
  idle(): boolean {
    return this.live() && members(this.pgid).length === 1
  }

  /** Kills the group, holder included, while it is still the command's group; returns whether it was. */
  kill(): boolean {
    if (!this.live()) return false
    try {
      process.kill(-this.pgid, "SIGKILL")
    } catch {
      return false
    }
    return true
  }
}
