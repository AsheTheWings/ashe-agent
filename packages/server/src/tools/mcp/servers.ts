import { Client, ProtocolError, StreamableHTTPClientTransport, type Transport } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { Redacted, Result } from "effect"
import type { Tool, ToolResult } from "../../agent/tools.ts"
import type { ToolContentPart } from "../../agent/window.ts"
import type { McpServers } from "../../inputs/shapes.ts"
import { parseEnvFile, parseHeadersFile, readCredentials } from "./credentials.ts"

/** A tool an MCP server lists, as the registry keeps it. */
interface Listed {
  readonly server: string
  readonly tool: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  /** Whether the server's tools are offered directly rather than through code mode. */
  readonly direct: boolean
}

/** Two or more MCP tools whose registered names are the same, none of which is registered. */
export interface Collision {
  readonly name: string
  readonly tools: ReadonlyArray<{ readonly server: string; readonly tool: string }>
}

export interface McpEvents {
  /** A server connected and listed its tools. */
  readonly connected?: (server: string, tools: number) => void
  /** A server failed to connect or disconnected; `reason` names no credential. */
  readonly unavailable?: (server: string, reason: string) => void
  /** Tools whose names collide and are left unregistered. */
  readonly collision?: (collision: Collision) => void
}

/** The registered name of an MCP tool: `<server>_<tool>` with characters outside `[A-Za-z0-9_-]` as `_`. */
export const registeredName = (server: string, tool: string) => `${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_")

interface Connection {
  readonly client: Client
  readonly tools: ReadonlyArray<Listed>
}

/** How long a liveness check after a failed request waits for the server's answer. */
const PROBE_TIMEOUT_MS = 5_000

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A tool result from an MCP result's content: text as text, images as images, other parts as JSON. */
const content = (server: string, tool: string, result: Record<string, unknown>): ReadonlyArray<ToolContentPart> => {
  const parts: Array<ToolContentPart> = []
  for (const part of Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : []) {
    if (part.type === "text" && typeof part.text === "string") parts.push({ type: "text", text: part.text })
    else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
      parts.push({ type: "image", path: `mcp:${server}/${tool}`, mimeType: part.mimeType, data: part.data })
    } else parts.push({ type: "text", text: JSON.stringify(part) })
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push({ type: "text", text: JSON.stringify(result.structuredContent) })
  return parts
}

/**
 * The configured MCP servers, connected through `@modelcontextprotocol/client`
 * over stdio or Streamable HTTP. Each server's tools are registered as
 * `<server>_<tool>` while it is connected; a server that fails to connect,
 * disconnects, or stops answering after a transport error removes only its
 * own tools. The client negotiates MCP 2026-07-28 and falls back to the
 * 2025 handshake for older servers. Credentials come only from
 * each entry's protected env or headers file, read at connection; no OAuth
 * flow is started.
 */
export class McpRegistry {
  private readonly connections = new Map<string, Connection>()
  /** Connections still connecting or listing tools, which `stop` aborts. */
  private readonly pending = new Map<string, { readonly client: Client; readonly abort: AbortController; transport?: Transport }>()
  /** Clients whose liveness check is running. */
  private readonly checking = new Set<Client>()
  private readonly reported = new Set<string>()
  private stopped = false

  constructor(
    private readonly servers: McpServers,
    private readonly options: {
      /** The environment stdio servers start with, before their env file's variables. */
      readonly env: Readonly<Record<string, string | undefined>>
      readonly version: string
      readonly events?: McpEvents
    },
  ) {}

  /** Connects to every server at once and settles when each has connected or failed. */
  async start(): Promise<void> {
    await Promise.all(Object.keys(this.servers).map((name) => this.connect(name)))
  }

  private transport(name: string) {
    const entry = this.servers[name]!
    if (entry.type === "stdio") {
      let fileEnv: Record<string, string> = {}
      if (entry.envFile !== undefined) {
        const read = readCredentials(entry.envFile, parseEnvFile)
        if (Result.isFailure(read)) throw new Error(`its env file ${read.failure}`)
        fileEnv = Redacted.value(read.success)
      }
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(this.options.env)) if (value !== undefined) env[key] = value
      return new StdioClientTransport({
        command: entry.command,
        args: [...(entry.args ?? [])],
        env: { ...env, ...fileEnv },
        stderr: "ignore",
      })
    }
    let headers: Record<string, string> = {}
    if (entry.headersFile !== undefined) {
      const read = readCredentials(entry.headersFile, parseHeadersFile)
      if (Result.isFailure(read)) throw new Error(`its headers file ${read.failure}`)
      headers = Redacted.value(read.success)
    }
    return new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers } })
  }

  private async connect(name: string) {
    const entry = this.servers[name]!
    const client = new Client({ name: "ashe-agent", version: this.options.version }, { versionNegotiation: { mode: "auto" } })
    const pending: { client: Client; abort: AbortController; transport?: Transport } = { client, abort: new AbortController() }
    const abort = pending.abort
    this.pending.set(name, pending)
    try {
      // Closing the transport, not the client, ends a connect that is still negotiating.
      pending.transport = this.transport(name)
      await client.connect(pending.transport, { signal: abort.signal })
      const tools: Array<Listed> = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor === undefined ? undefined : { cursor }, { signal: abort.signal })
        for (const tool of page.tools) {
          tools.push({
            server: name,
            tool: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema as Record<string, unknown>,
            direct: entry.codemode === false,
          })
        }
        cursor = page.nextCursor
      } while (cursor !== undefined)
      this.pending.delete(name)
      if (this.stopped) {
        await client.close()
        return
      }
      this.connections.set(name, { client, tools })
      client.onclose = () => this.lost(name, client, "disconnected")
      client.onerror = () => void this.check(name, client)
      this.options.events?.connected?.(name, tools.length)
      this.reportCollisions()
    } catch (error) {
      this.pending.delete(name)
      await client.close().catch(() => undefined)
      if (!this.stopped) this.options.events?.unavailable?.(name, `failed to connect: ${describeError(error)}`)
    }
  }

  /** Removes a connected server's tools and closes its client, once. */
  private lost(name: string, client: Client, reason: string) {
    if (this.connections.get(name)?.client !== client) return
    this.connections.delete(name)
    void client.close().catch(() => undefined)
    if (!this.stopped) this.options.events?.unavailable?.(name, reason)
  }

  /**
   * After a transport error or a failed request, asks the server for its
   * tools, bypassing the client's cache, since every protocol revision and
   * every tool server supports that request. A server that answers, with
   * its tools or with an error response, keeps its tools, so an error it
   * reports for one request removes nothing; one that does not answer in
   * time, or cannot be reached, is lost.
   */
  private async check(name: string, client: Client) {
    if (this.checking.has(client) || this.connections.get(name)?.client !== client) return
    this.checking.add(client)
    try {
      await client.listTools(undefined, { cacheMode: "bypass", timeout: PROBE_TIMEOUT_MS })
    } catch (error) {
      if (!(error instanceof ProtocolError)) this.lost(name, client, `stopped answering: ${describeError(error)}`)
    } finally {
      this.checking.delete(client)
    }
  }

  /** The connected servers' tools grouped by registered name. */
  private byName() {
    const groups = new Map<string, Array<Listed>>()
    for (const connection of this.connections.values()) {
      for (const tool of connection.tools) {
        const name = registeredName(tool.server, tool.tool)
        groups.set(name, [...(groups.get(name) ?? []), tool])
      }
    }
    return groups
  }

  /** Collisions among the connected servers' tools. */
  collisions(): ReadonlyArray<Collision> {
    return [...this.byName()]
      .filter(([, tools]) => tools.length > 1)
      .map(([name, tools]) => ({
        name,
        tools: tools
          .map((tool) => ({ server: tool.server, tool: tool.tool }))
          .toSorted((a, b) => byCodePoint(a.server, b.server) || byCodePoint(a.tool, b.tool)),
      }))
  }

  private reportCollisions() {
    for (const collision of this.collisions()) {
      const key = JSON.stringify(collision)
      if (this.reported.has(key)) continue
      this.reported.add(key)
      this.options.events?.collision?.(collision)
    }
  }

  /**
   * The registered tools of the connected servers, without colliding names.
   * `direct` selects the tools offered to the model directly, or those for
   * code mode.
   */
  tools(direct: boolean): ReadonlyArray<Tool> {
    const registered: Array<Tool> = []
    for (const [name, group] of this.byName()) {
      if (group.length !== 1 || group[0]!.direct !== direct) continue
      registered.push(this.tool(name, group[0]!))
    }
    return registered
  }

  private tool(name: string, listed: Listed): Tool {
    return {
      namespace: listed.server,
      name: listed.tool,
      spec: { name, description: listed.description, parameters: listed.inputSchema },
      run: async (args, run): Promise<ToolResult> => {
        await run.authorize({ permission: name, subjects: ["*"], patterns: ["*"] })
        const connection = this.connections.get(listed.server)
        if (connection === undefined) return { outcome: "failed", content: `The MCP server ${listed.server} is not connected.` }
        run.started()
        let result: Record<string, unknown>
        try {
          result = (await connection.client.callTool(
            { name: listed.tool, arguments: (args ?? {}) as Record<string, unknown> },
            { signal: run.signal },
          )) as Record<string, unknown>
        } catch (error) {
          if (run.signal.aborted) throw error
          await this.check(listed.server, connection.client)
          return { outcome: "failed", content: `The MCP tool failed: ${describeError(error)}` }
        }
        return { outcome: result.isError === true ? "failed" : "success", content: content(listed.server, listed.tool, result) }
      },
    }
  }

  /** Aborts every pending connection and closes every client, stdio server processes included. */
  async stop() {
    this.stopped = true
    const clients = [...this.connections.values(), ...this.pending.values()].map((entry) => entry.client)
    const transports = [...this.pending.values()].flatMap((entry) => (entry.transport === undefined ? [] : [entry.transport]))
    for (const { abort } of this.pending.values()) abort.abort()
    this.connections.clear()
    this.pending.clear()
    await Promise.all([
      ...transports.map((transport) => transport.close().catch(() => undefined)),
      ...clients.map((client) => client.close().catch(() => undefined)),
    ])
  }
}
