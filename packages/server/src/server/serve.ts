import { Context, Effect, Layer } from "effect"
import { Store } from "../store/database.ts"
import { startWebSocketServer, type Handlers, type WebSocketServer } from "./websocket.ts"

export interface ServeOptions {
  readonly hostname: string
  readonly port: number
  readonly origins: ReadonlyArray<string>
  readonly handlers: Handlers
}

/** The listening protocol server, stopped when its layer is released. */
export class ProtocolServer extends Context.Service<ProtocolServer, WebSocketServer>()(
  "ashe-agent/server/ProtocolServer",
) {
  static readonly layer = (options: ServeOptions) =>
    Layer.effect(
      ProtocolServer,
      Effect.gen(function* () {
        const { db } = yield* Store
        return yield* Effect.acquireRelease(
          Effect.sync(() => startWebSocketServer({ db, ...options })),
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
