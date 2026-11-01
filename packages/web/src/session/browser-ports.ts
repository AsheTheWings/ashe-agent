import type { SessionClientPorts } from "./ports.ts"

/** The session client's ports in a browser: WebSocket, `localStorage`, and Web Locks. */
export const browserPorts = (): SessionClientPorts => ({
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
  // Web Locks exist only in secure contexts; elsewhere the task runs unlocked.
  withLock: (name, task) => ("locks" in navigator ? navigator.locks.request(name, task) : task()),
  now: () => Date.now(),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (timer) => {
    if (typeof timer === "number") window.clearTimeout(timer)
  },
})
