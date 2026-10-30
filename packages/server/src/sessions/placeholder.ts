import { Effect } from "effect"
import { ErrorCode } from "@ashe-agent/protocol"
import { ProtocolError } from "../server/websocket.ts"
import type { SessionSetup, TurnRunner } from "./hub.ts"

/**
 * The turn runner `serve` uses: the server has no agent loop yet, so each
 * turn ends at once with an error saying so.
 */
export const unavailableRunner: TurnRunner = () =>
  Effect.succeed({ status: "failed", message: "this server has no agent loop yet", code: "unavailable" })

/** Session setup with no agents and no instructions. */
export const noAgents: SessionSetup = {
  resolve: (agent) => {
    if (agent !== null) throw new ProtocolError({ code: ErrorCode.invalidInput, message: `no agent ${agent}` })
    return { agent: null, instructions: null }
  },
}
