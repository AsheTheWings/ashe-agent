/** Failed logins that lock login, and how long each counts and the lock lasts. */
export const LOGIN_FAILURE_LIMIT = 5
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000

/**
 * When login unlocks, or null when it is not locked: after
 * `LOGIN_FAILURE_LIMIT` failures within the window, login stays locked
 * until the window's length after the last of them. Attempts refused while
 * locked are not failures.
 */
export const loginLockedUntil = (failures: ReadonlyArray<number>, now: number): number | null => {
  if (failures.length < LOGIN_FAILURE_LIMIT) return null
  const latest = [...failures].sort((a, b) => b - a)
  const last = latest[0]!
  const fifthLast = latest[LOGIN_FAILURE_LIMIT - 1]!
  if (last - fifthLast >= LOGIN_FAILURE_WINDOW_MS) return null
  const until = last + LOGIN_FAILURE_WINDOW_MS
  return now < until ? until : null
}
