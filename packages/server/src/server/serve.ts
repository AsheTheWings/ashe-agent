import { Context, Effect, Layer } from "effect"
import type { GithubSignInConfig } from "../auth/github.ts"
import { sessionHandlers } from "../sessions/handlers.ts"
import { Sessions } from "../sessions/hub.ts"
import { Store } from "../store/database.ts"
import { startWebSocketServer, type WebSocketServer } from "./websocket.ts"

export interface ServeOptions {
  readonly hostname: string
  readonly port: number
  readonly origins: ReadonlyArray<string>
  readonly github: GithubSignInConfig
}

/** The listening protocol server over the session hub, stopped when its layer is released. */
export class ProtocolServer extends Context.Service<ProtocolServer, WebSocketServer>()(
  "ashe-agent/server/ProtocolServer",
) {
  static readonly layer = (options: ServeOptions) =>
    Layer.effect(
      ProtocolServer,
      Effect.gen(function* () {
        const { db } = yield* Store
        const hub = yield* Sessions
        const { handlers, onClose } = sessionHandlers(hub)
        return yield* Effect.acquireRelease(
          Effect.sync(() => startWebSocketServer({ db, ...options, handlers, onClose })),
          (server) => Effect.promise(() => server.stop()),
        )
      }),
    )
}

/**
 * Runs the server until interrupted: reports its URL through `onListening`,
 * then waits, releasing the server and the database on interruption.
 */
export const serveProgram = (onListening: (url: string) => void) =>
  Effect.gen(function* () {
    const server = yield* ProtocolServer
    onListening(server.url)
    return yield* Effect.never
  })
