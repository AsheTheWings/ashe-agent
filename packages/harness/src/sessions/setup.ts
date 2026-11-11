import { ErrorCode } from "@ashe-agent/protocol"
import { implicitAgent } from "../agents/agents.ts"
import { ProtocolError } from "../server/websocket.ts"
import type { SessionSetup } from "./hub.ts"

/** Session setup with only the implicit agent, no user instructions, and empty catalogs. */
export const noAgents: SessionSetup = {
  resolve: (agent) => {
    if (agent !== null) throw new ProtocolError({ code: ErrorCode.invalidInput, message: `no agent ${agent}` })
    return implicitAgent
  },
  userInstructions: () => null,
  catalogs: () => ({ skills: null, codeMode: null }),
  agents: () => ({ agents: [], defaultAgent: null }),
}
