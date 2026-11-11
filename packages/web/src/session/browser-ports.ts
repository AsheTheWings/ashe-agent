import type { SessionClientPorts } from "./ports.ts"

/** The session client's ports in a browser: WebSocket, `localStorage`, and Web Locks. */
export const browserPorts = (serverUrl: string): SessionClientPorts => ({
  serverUrl,
  openSocket: (url, handlers) => {
    let closed = false
    const close = (code: number, reason: string) => {
      if (closed) return
      closed = true
      handlers.onClose(code, reason)
    }
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      // An invalid URL throws instead of closing; report it as a close after this call returns.
      queueMicrotask(() => close(1006, "invalid server URL"))
      return { send: () => {}, close: () => {} }
    }
    socket.onopen = () => handlers.onOpen()
    socket.onmessage = (event) => {
      if (typeof event.data === "string") handlers.onMessage(event.data)
    }
    socket.onclose = (event) => close(event.code, event.reason)
    return {
      send: (text) => socket.send(text),
      close: (code, reason) => socket.close(code, reason),
    }
  },
  storage: window.localStorage,
  signIn: {
    storage: window.sessionStorage,
    origin: window.location.origin,
    fragment: () => window.location.hash,
    clearFragment: () => window.history.replaceState(null, "", window.location.pathname + window.location.search),
    navigate: (url) => window.location.assign(url),
    randomBytes: () => window.crypto.getRandomValues(new Uint8Array(32)),
  },
  // An unlocked refresh could replay a rotated token and invalidate the login.
  withLock: (name, task) => {
    if (!("locks" in navigator)) return Promise.reject(new Error("Web Locks are unavailable; sign in again in a secure context"))
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 15_000)
    return navigator.locks.request(name, { mode: "exclusive", signal: controller.signal }, task).finally(() => window.clearTimeout(timer))
  },
  now: () => Date.now(),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (timer) => {
    if (typeof timer === "number") window.clearTimeout(timer)
  },
})
