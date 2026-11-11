#!/usr/bin/env bun
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { Redacted } from "effect"
import { processSources } from "@ashe-agent/harness/inputs"
import { resolveInputs } from "@ashe-agent/harness/inputs/resolve"
import { startTelemetry } from "@ashe-agent/harness/telemetry"
import type { WebSessionState } from "../shared/web-state.ts"
import { loadWebConfig, WebInputError, type WebConfig } from "./config.ts"
import { applyMigrations, discoverMigrations, MigrationError, readMigrationStatus } from "./migrations.ts"
import { WebObserver } from "./observer.ts"
import { WebServer } from "./server.ts"
import { WebStore } from "./store.ts"

declare const ASHE_AGENT_REVISION: string | undefined
const revision = typeof ASHE_AGENT_REVISION === "undefined" ? "unknown" : ASHE_AGENT_REVISION

const usage = `ashe-agent-web, the built-in browser application's backend

usage: ashe-agent-web <command>

commands:
  serve                    run the web backend and observer
  migrate                  apply pending web database migrations
  migrate status           list applied and pending migrations without writing
  db dump <path>           write a consistent web database copy
  --version                print the revision this backend was built from
`

const fail = (message: string, code = 1): never => {
  process.stderr.write(`ashe-agent-web: ${message}\n`)
  process.exit(code)
}

const usageError = (message: string): never => fail(`${message}\n\n${usage}`, 64)

const databasePath = (stateDir: string) => join(stateDir, "web.sqlite")

const migrationDirectory = (configured: string | null) => {
  return configured ?? fail("ASHE_AGENT_WEB_MIGRATIONS_DIR is required", 2)
}

const openDatabase = (path: string, readOnly = false) => {
  if (!readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = readOnly ? new Database(path, { readonly: true }) : new Database(path, { create: true })
  if (!readOnly) db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA busy_timeout = 5000")
  return db
}

const commandMigrate = (statusOnly: boolean) => {
  const resolution = resolveInputs("webMigrate", processSources())
  if (!resolution.ok) {
    const message = resolution.issues.map((issue) => `  ${issue.input}: ${issue.problem}`).join("\n")
    return fail(`invalid inputs\n${message}`, 2)
  }
  const directory = migrationDirectory(resolution.inputs.webMigrationsDir)
  const migrations = discoverMigrations(directory)
  const path = databasePath(resolution.inputs.webStateDir)
  if (statusOnly && !existsSync(path)) {
    process.stdout.write(`applied: 0\npending:\n${migrations.map((migration) => `  ${migration.name}`).join("\n")}\n`)
    return
  }
  const db = openDatabase(path, statusOnly)
  try {
    const status = readMigrationStatus(db, migrations)
    if (statusOnly) {
      process.stdout.write(`applied: ${status.applied.length}\n${status.applied.map((row) => `  ${row.name}`).join("\n")}\npending: ${status.pending.length}\n${status.pending.map((name) => `  ${name}`).join("\n")}\n`)
      return
    }
    const applied = applyMigrations(db, migrations)
    process.stdout.write(`applied ${applied} web migration(s) to ${path}\n`)
  } finally {
    db.close()
  }
}

const commandDump = (given: string) => {
  const resolution = resolveInputs("webDb", processSources())
  if (!resolution.ok) {
    const message = resolution.issues.map((issue) => `  ${issue.input}: ${issue.problem}`).join("\n")
    return fail(`invalid inputs\n${message}`, 2)
  }
  const path = databasePath(resolution.inputs.webStateDir)
  if (!existsSync(path)) fail(`no web database at ${path}; run migrate`)
  const destination = isAbsolute(given) ? given : resolve(given)
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  const db = new Database(path, { readonly: true })
  try {
    db.run("VACUUM INTO ?", [temporary])
    const file = openSync(temporary, "r")
    try {
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporary, destination)
    const directory = openSync(dirname(destination), "r")
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
    fail(error instanceof Error ? error.message : "dump failed")
  } finally {
    db.close()
  }
  process.stdout.write(`wrote ${destination}\n`)
}

const commandServe = async () => {
  const config: WebConfig = loadWebConfig(processSources())
  const assetsDir = config.inputs.webAssetsDir ?? fail("ASHE_AGENT_WEB_ASSETS_DIR is required", 2)
  const observerToken = config.observerToken ?? fail("ASHE_AGENT_WEB_OBSERVER_CREDENTIAL_FILE is required", 2)
  const migrations = discoverMigrations(migrationDirectory(config.inputs.webMigrationsDir))
  const path = databasePath(config.inputs.webStateDir)
  const db = openDatabase(path)
  const status = readMigrationStatus(db, migrations)
  if (status.pending.length > 0) {
    db.close()
    fail(`${status.pending.length} web migration(s) pending; run ashe-agent-web migrate`)
  }
  const store = new WebStore(db)
  const telemetry = startTelemetry({
    traces: config.inputs.tracesExporter,
    metrics: config.inputs.metricsExporter,
    logs: config.inputs.logsExporter,
    endpoint: config.inputs.otlpEndpoint,
    protocol: config.inputs.otlpProtocol,
    headers: config.otlpHeaders,
    serviceVersion: revision,
    deploymentEnvironment: config.inputs.deploymentEnvironment,
    serviceName: "ashe-agent-web",
  })
  let server: WebServer | null = null
  const observer = new WebObserver({
    harnessUrl: config.inputs.webHarnessUrl,
    token: observerToken,
    store,
    now: Date.now,
    onChange: (changed: ReadonlyArray<WebSessionState>) => server?.broadcast(changed),
  })
  server = new WebServer({
    hostname: config.inputs.webListenHost,
    port: config.inputs.webListenPort,
    harnessUrl: config.inputs.webHarnessUrl,
    origins: config.inputs.webOrigins,
    assetsDir,
    store,
    migrations,
    revision,
    now: Date.now,
  })
  observer.start()
  const filing = setInterval(() => {
    server?.broadcast(store.fileInactive(Date.now(), config.inputs.webInactivityDays))
  }, 60_000)
  const shutdown = async (signal: string) => {
    process.stdout.write(`ashe-agent-web: ${signal}; stopping\n`)
    clearInterval(filing)
    observer.stop()
    server?.stop()
    await telemetry.shutdown()
    store.close()
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.stdout.write(`ashe-agent-web listening on http://${config.inputs.webListenHost}:${server.server.port}\n`)
  await new Promise(() => {})
}

const args = process.argv.slice(2)
const [command, ...rest] = args
if (command === "--version") process.stdout.write(`${revision}\n`)
else if (command === "serve" && rest.length === 0) await commandServe()
else if (command === "migrate" && rest.length === 0) commandMigrate(false)
else if (command === "migrate" && rest.length === 1 && rest[0] === "status") commandMigrate(true)
else if (command === "db" && rest.length === 2 && rest[0] === "dump") commandDump(rest[1]!)
else usageError(command === undefined ? "a command is required" : `unknown command ${command}`)
