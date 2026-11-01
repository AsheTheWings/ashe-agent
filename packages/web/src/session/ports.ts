/**
 * What the session client needs from its platform. The browser provides
 * them in `browser-ports.ts`; tests provide their own.
 */

export type SocketHandlers = {
  readonly onOpen: () => void
  readonly onMessage: (text: string) => void
  /** Called once when the socket closes, whether it opened or not. */
  readonly onClose: (code: number, reason: string) => void
}

export type Socket = {
  send(text: string): void
  /** Closes with 1000 or a code from 3000 to 4999, the codes a browser lets a client send. */
  close(code?: number, reason?: string): void
}

/** A key-value store that outlives the page, such as `localStorage`. */
export type KeyValueStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type SessionClientPorts = {
  readonly serverUrl: string
  readonly openSocket: (url: string, handlers: SocketHandlers) => Socket
  readonly storage: KeyValueStorage
  readonly signIn: {
    readonly storage: KeyValueStorage
    readonly origin: string
    readonly fragment: () => string
    readonly clearFragment: () => void
    readonly navigate: (url: string) => void
    readonly randomBytes: () => Uint8Array
  }
  /**
   * Runs `task` while holding the lock `name`, shared by every page of the
   * client's origin, so only one page at a time exchanges the stored
   * refresh token.
   */
  readonly withLock: <T>(name: string, task: () => Promise<T>) => Promise<T>
  /** Milliseconds since the Unix epoch. */
  readonly now: () => number
  readonly setTimer: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer: (timer: unknown) => void
}
