import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"

const entry = join(import.meta.dir, "../scripts/dev.ts")

/** Runs real Vite in a process of this test with synthetic inputs and an allocated loopback port. */
const start = (home: string, port: number) => Bun.spawn([process.execPath, "--eval", `
  const { createDevelopmentWebServer } = await import(${JSON.stringify(entry)})
  const server = await createDevelopmentWebServer(${JSON.stringify(home)})
  try {
    await server.listen(${port})
    process.stdout.write("READY " + JSON.stringify({ url: server.resolvedUrls.local[0], strict: server.config.server.strictPort, production: server.config.isProduction }) + "\\n")
    process.on("SIGTERM", async () => { await server.close(); process.exit(0) })
  } catch (error) {
    await server.close()
    process.stderr.write(String(error))
    process.exit(1)
  }
`], {
  cwd: home,
  env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), LANG: "C.UTF-8", TZ: "UTC",
    ASHE_AGENT_CONFIG_FILE: join(home, "config.json"), ASHE_AGENT_PROFILE: "production",
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "unexpected.example", NODE_ENV: "production",
  },
  stdin: "ignore", stdout: "pipe", stderr: "pipe",
})

const bounded = async <A>(what: string, operation: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`integration dev-web: timed out waiting for ${what}; reproduce with bun run test:integration`)), 15_000)
    })])
  } finally { clearTimeout(timer) }
}

const ready = async (child: Subprocess<"ignore", "pipe", "pipe">) => {
  const reader = child.stdout.getReader()
  let output = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`integration dev-web: exited before ready with ${await child.exited}; reproduce with bun run test:integration`)
    output += new TextDecoder().decode(value)
    const line = output.split("\n").find((line) => line.startsWith("READY "))
    if (line) return JSON.parse(line.slice(6)) as { url: string; strict: boolean; production: boolean }
  }
}

describe("development web input boundary", () => {
  test("catalog hosts are admitted and inherited Vite host and mode overrides are suppressed", async () => {
    const home = mkdtempSync(join(tmpdir(), "ashe-agent-dev-web-"))
    writeFileSync(join(home, "index.html"), "<!doctype html><title>Development web test</title>")
    writeFileSync(join(home, "config.json"), JSON.stringify({ devWebAllowedHosts: ["configured.example"] }))
    const child = start(home, 0)
    const errors = new Response(child.stderr).text()
    try {
      const listening = await bounded("readiness", ready(child))
      expect(listening.strict).toBe(true)
      expect(listening.production).toBe(false)
      expect((await fetch(listening.url, { headers: { Host: "configured.example" } })).status).toBe(200)
      expect((await fetch(listening.url, { headers: { Host: "unexpected.example" } })).status).toBe(403)
    } finally {
      child.kill()
      await bounded("shutdown", child.exited)
      await errors
      rmSync(home, { recursive: true, force: true })
    }
  }, 25_000)

  test("an occupied port fails instead of choosing another port", async () => {
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
    const home = mkdtempSync(join(tmpdir(), "ashe-agent-dev-web-"))
    writeFileSync(join(home, "index.html"), "<!doctype html><title>Development web test</title>")
    writeFileSync(join(home, "config.json"), "{}")
    const child = start(home, occupied.port!)
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    try {
      expect(await bounded("occupied port refusal", child.exited)).toBe(1)
      expect(await output).not.toContain("READY ")
      expect(await errors).toContain("already in use")
    } finally {
      child.kill()
      await child.exited
      occupied.stop(true)
      rmSync(home, { recursive: true, force: true })
    }
  }, 25_000)
})
