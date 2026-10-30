import type { McpEvents } from "../tools/mcp/servers.ts"
import { emitLog } from "./signals.ts"

/** MCP registry events as log records: a server's name and error class, never its reason text. */
export const mcpLogEvents: McpEvents = {
  unavailable: (server, _reason, cause) => emitLog("ashe_agent.mcp.unavailable", { "ashe_agent.mcp.server": server, "error.type": `mcp_${cause}` }),
  collision: (collision) => emitLog("ashe_agent.mcp.collision", { "ashe_agent.tool": collision.name }),
}
