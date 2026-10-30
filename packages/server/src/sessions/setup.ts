import { ErrorCode } from "@ashe-agent/protocol"
import { ProtocolError } from "../server/websocket.ts"
import { noAgentSettings } from "../agents/agents.ts"
import type { SessionSetup } from "./hub.ts"

/** Session setup with no agents, no instructions, and empty catalogs. */
export const noAgents: SessionSetup = {
  resolve: (agent) => {
    if (agent !== null) throw new ProtocolError({ code: ErrorCode.invalidInput, message: `no agent ${agent}` })
    return { agent: null, instructions: null, model: null, settings: noAgentSettings }
  },
  catalogs: () => ({ skills: null, codeMode: null }),
}
