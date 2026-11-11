/** The shell a command runs in when the user database names none. */
export const FALLBACK_SHELL = "/bin/sh"

/**
 * The login shell in a `passwd` entry, `name:password:uid:gid:gecos:home:shell`,
 * or null when the entry names no absolute path there.
 */
export const shellOfPasswdEntry = (entry: string): string | null => {
  const fields = entry.trim().split(":")
  if (fields.length !== 7) return null
  const shell = fields[6]!
  return shell.startsWith("/") ? shell : null
}

/**
 * The login shell the user database gives the user `uid`, through
 * `getent` so every configured source answers, or `/bin/sh` when it gives
 * none. The process environment's `SHELL` is not consulted: a service may
 * run without it, or with another user's.
 */
export const loginShell = (uid: number): string => {
  try {
    const lookup = Bun.spawnSync(["getent", "passwd", String(uid)], { stdin: "ignore", stderr: "ignore" })
    if (lookup.exitCode !== 0) return FALLBACK_SHELL
    return shellOfPasswdEntry(lookup.stdout.toString().split("\n")[0] ?? "") ?? FALLBACK_SHELL
  } catch {
    return FALLBACK_SHELL
  }
}
