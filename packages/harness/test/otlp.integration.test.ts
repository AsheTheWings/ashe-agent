import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { CliRun, Client, waitFor } from "./support/cli.ts"

type Received = { readonly path: string; readonly headers: Record<string, string>; readonly body: string }

/** A run-owned OTLP/HTTP receiver that records every export and accepts it. */
const otlpReceiver = () => {
  const received: Array<Received> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push({ path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers), body: await request.text() })
      return Response.json({})
    },
  })
  return { received, endpoint: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

/** The resource attributes of an OTLP/JSON export, as a name-to-value map. */
const resourceOf = (body: string) => {
  const parsed = JSON.parse(body) as Record<string, Array<{ resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> } }>>
  const [first] = Object.values(parsed)[0]!
  return Object.fromEntries(first!.resource.attributes.map(({ key, value }) => [key, Object.values(value)[0]]))
}

describe("OTLP export", () => {
  test("traces, metrics, and logs reach the configured endpoint with the protected headers and the resource, which no signal carries", async () => {
    const receiver = otlpReceiver()
    const secret = "HEADER-SECRET-91c2"
    const environment = `otlp-test-${crypto.randomUUID()}`
    const run = new CliRun({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      ASHE_AGENT_DEPLOYMENT_ENVIRONMENT: environment,
      ASHE_AGENT_MCP_SERVERS: JSON.stringify({ broken: { type: "stdio", command: "/nonexistent/mcp-server" } }),
    })
    const headersFile = join(run.dir, "otlp-headers")
    writeFileSync(headersFile, `# synthetic credentials\nx-otlp-key=${secret}\nauthorization=Bearer ${secret}-bearer\n`)
    chmodSync(headersFile, 0o600)
    run.env.ASHE_AGENT_OTLP_HEADERS_FILE = headersFile
    try {
      await run.prepare()
      const token = (await run.run(["token", "create", "telemetry"])).stdout.trim()
      const url = await run.serve()
      const client = await Client.connect(url)
      expect((await client.request("auth.authenticate", { token, protocolVersion: 1 })).error).toBeUndefined()
      expect((await client.request("models.list")).error).toBeUndefined()
      client.close()
      // Stopping the server flushes every signal it holds.
      await run.stopServers()
      const paths = () => new Set(receiver.received.map((entry) => entry.path))
      await waitFor("traces, metrics, and logs", () => (["/v1/traces", "/v1/metrics", "/v1/logs"].every((path) => paths().has(path)) ? true : undefined), 15_000)

      for (const entry of receiver.received) {
        expect(entry.headers["x-otlp-key"]).toBe(secret)
        expect(entry.headers.authorization).toBe(`Bearer ${secret}-bearer`)
        expect(entry.body).not.toContain(secret)
        expect(entry.body).not.toContain("synthetic credentials")
        const resource = resourceOf(entry.body)
        expect(resource).toMatchObject({
          "service.namespace": "ashe-agent",
          "service.name": "ashe-agent-server",
          "deployment.environment.name": environment,
        })
        expect(typeof resource["service.version"]).toBe("string")
        expect(typeof resource["service.instance.id"]).toBe("string")
      }
      const traces = receiver.received.filter((entry) => entry.path === "/v1/traces").map((entry) => entry.body).join("")
      expect(traces).toContain("ashe_agent.request")
      const logs = receiver.received.filter((entry) => entry.path === "/v1/logs").map((entry) => entry.body).join("")
      expect(logs).toContain("ashe_agent.mcp.unavailable")
    } finally {
      await run.cleanup()
      receiver.stop()
    }
  }, 60_000)
})
