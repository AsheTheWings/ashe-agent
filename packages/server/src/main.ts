#!/usr/bin/env bun
/**
 * The `ashe-agent` command line: the server and its operator commands.
 * Each command resolves and validates its inputs before any other work.
 */
import { dirname, join, resolve } from "node:path"
import { existsSync } from "node:fs"
import { userInfo } from "node:os"
import { loginShell } from "./tools/shell/login-shell.ts"
import { Cause, Effect, Exit, Fiber, Layer, Redacted, Result } from "effect"
import { createApiToken, hasOwnerPassword, listApiTokens, revokeApiToken, setOwnerPassword } from "./auth/credentials.ts"
import { readSecretLine } from "./cli/terminal.ts"
import { loadInputsOrExit, processSources, readDiskFile, removeDependencyVariables } from "./inputs/bootstrap.ts"
import { readProviderKeys } from "./inputs/resolve.ts"
import { catalog } from "./inputs/catalog.ts"
import { ProtocolServer, serveProgram } from "./server/serve.ts"
import { protocolUrl } from "./server/websocket.ts"
import { Sessions } from "./sessions/hub.ts"
import { AgentRegistry } from "./agents/agents.ts"
import { fileSetup } from "./agents/setup.ts"
import { configuredModels } from "./models/registry.ts"
import { databasePath, openDatabase, openDatabaseReadonly, Store } from "./store/database.ts"
import { dumpDatabase } from "./store/dump.ts"
import { migrationFiles } from "./store/migration-files.ts"
import { applyMigrations, discoverMigrations, MigrationError, readMigrationStatus } from "./store/migrations.ts"
import { mcpLogEvents } from "./telemetry/mcp-events.ts"
import { parseOtlpHeaders } from "./telemetry/headers.ts"

declare const ASHE_AGENT_REVISION: string | undefined

/** The commit the binary was built from, stamped at build time. */
const revision = typeof ASHE_AGENT_REVISION === "undefined" ? "unknown" : ASHE_AGENT_REVISION

const usage = `AsheAgent, a single-owner agent server

usage: ashe-agent <command>

commands:
  serve                    run the server
  check                    validate the server's inputs and print the URL it would serve
  migrate                  apply pending database migrations
  migrate status           list applied and pending migrations without writing
  db dump <path>           write a consistent copy of the database to <path>
  owner set-password       set the owner password, read from the terminal
  token create <name>      create an API token and print it once
  token list               list active API tokens
  token revoke <name>      revoke an API token
  --version                print AsheAgent and the revision this binary was built from
`

/** Exit codes: 1 for a failed command, 2 for invalid inputs, 64 for a usage error. */
const fail = (message: string, code = 1): never => {
  process.stderr.write(`ashe-agent: ${message}\n`)
  process.exit(code)
}

const usageError = (message: string): never => fail(`${message}\n\n${usage}`, 64)

const migrations = () => discoverMigrations(migrationFiles)

/** The database for an operator command: it must exist and have every migration applied. */
const openCurrentDatabase = (stateDir: string) => {
  const path = databasePath(stateDir)
  if (!existsSync(path)) fail(`no database at ${path}; run ashe-agent migrate`)
  const db = openDatabase(path)
  const status = readMigrationStatus(db, migrations())
  if (status.pending.length > 0) {
    db.close()
    fail(`${status.pending.length} migration(s) pending; run ashe-agent migrate`)
  }
  return db
}

const formatTime = (ms: number | null) => (ms === null ? "never" : new Date(ms).toISOString())

/**
 * Serve's inputs, provider API keys, and OTLP export headers, validated
 * before any other work; invalid ones exit with status 2.
 */
const serveInputs = () => {
  const sources = processSources()
  const { inputs } = loadInputsOrExit("serve", sources)
  removeDependencyVariables(process.env)
  const keys = readProviderKeys(inputs.providers, readDiskFile)
  if (Result.isFailure(keys)) {
    fail(`invalid inputs\n${keys.failure.map((issue) => `  ${issue.input}: ${issue.problem}`).join("\n")}`, 2)
  }
  const headers = inputs.otlpHeaders === null ? Result.succeed({}) : parseOtlpHeaders(Redacted.value(inputs.otlpHeaders))
  if (Result.isFailure(headers)) fail(`invalid inputs\n  ${catalog.otlpHeadersFile.env}: ${headers.failure}`, 2)
  return { sources, inputs, apiKeys: Result.getOrThrow(keys), otlpHeaders: Redacted.make(Result.getOrThrow(headers)) }
}

const commands: Record<string, (args: ReadonlyArray<string>) => Promise<void>> = {
  async serve(args) {
    if (args.length > 0) usageError("serve takes no arguments")
    const { sources, inputs, apiKeys, otlpHeaders } = serveInputs()
    const models = configuredModels(inputs.providers)
    openCurrentDatabase(inputs.stateDir).close()
    // The agent loop's libraries load only for serve, so operator commands start quickly.
    const [
      { responsesModelPort },
      { agentRunner },
      { ShellProcesses },
      { builtinTools },
      { McpRegistry },
      { executeTool, sessionCodeModeCatalog },
      { startTelemetry },
    ] = await Promise.all([
      import("./agent/model.ts"),
      import("./agent/runner.ts"),
      import("./tools/shell/index.ts"),
      import("./tools/builtin.ts"),
      import("./tools/mcp/servers.ts"),
      import("./tools/codemode/execute.ts"),
      import("./telemetry/sdk.ts"),
    ])
    // The SDK starts before any work, so every signal reaches the selected exporters.
    const telemetry = startTelemetry({
      traces: inputs.tracesExporter,
      metrics: inputs.metricsExporter,
      logs: inputs.logsExporter,
      endpoint: inputs.otlpEndpoint,
      protocol: inputs.otlpProtocol,
      headers: otlpHeaders,
      serviceVersion: revision,
      deploymentEnvironment: inputs.deploymentEnvironment,
    })
    const { effectLayer, shutdown: shutdownTelemetry } = telemetry
    // Commands run in the server user's login shell, without the server's own
    // input variables; every process ends with the server.
    const commandEnv: Record<string, string | undefined> = { ...process.env }
    for (const input of Object.values(catalog)) if ("env" in input) delete commandEnv[input.env]
    const processes = new ShellProcesses({
      shell: loginShell(process.getuid?.() ?? userInfo().uid),
      envFile: inputs.shellEnvFile,
      env: commandEnv,
      maxProcesses: inputs.shellMaxProcesses,
    })
    const endProcesses = () => processes.stopAll()
    process.on("exit", endProcesses)
    const builtin = builtinTools(inputs, processes)
    const port = responsesModelPort((id) => {
      const model = models.find((candidate) => candidate.id === id)
      const key = model === undefined ? undefined : apiKeys.get(model.provider)
      if (model === undefined || key === undefined) return undefined
      return { baseURL: inputs.providers[model.provider]!.baseURL, apiKey: Redacted.value(key), upstream: model.upstream }
    })
    // MCP servers connect in the background; each server's tools appear once it has listed them.
    const mcp = new McpRegistry(inputs.mcpServers, {
      env: commandEnv,
      version: revision,
      events: mcpLogEvents,
    })
    void mcp.start()
    // Code mode programs call the tools of servers without `codemode: false`; `execute` is offered while there are any.
    const execute = executeTool(() => mcp.tools(false), inputs.codeModeLimits)
    const tools = () => [...builtin, ...mcp.tools(true), ...(mcp.tools(false).length === 0 ? [] : [execute])]
    const layer = ProtocolServer.layer({
      hostname: inputs.listenHost,
      port: inputs.listenPort,
      origins: inputs.origins,
    }).pipe(
      Layer.provideMerge(
        Sessions.layer({
          models,
          defaultModel: inputs.defaultModel,
          sessionsDir: join(inputs.stateDir, "sessions"),
          memoryDir: join(inputs.stateDir, "memory"),
          scratchRoot: inputs.scratchRoot,
          setup: fileSetup({
            agents: new AgentRegistry(inputs.agents, inputs.defaultAgent, inputs.titlesDir),
            instructionsFile: inputs.instructionsFile,
            skillRoots: inputs.skillRoots,
            codeMode: sessionCodeModeCatalog(() => mcp.tools(false)),
          }),
          tools,
          permission: inputs.permission,
          home: sources.dirs.home,
          userTimeZone: inputs.userTimeZone,
          port,
          auxiliaryModels: inputs.auxiliaryModels,
          runner: agentRunner({ port, models }),
        }),
      ),
      Layer.provide(Store.layer(databasePath(inputs.stateDir))),
      Layer.provide(effectLayer),
    )
    let interrupt = () => {}
    let stopping = false
    const stop = () => {
      stopping = true
      interrupt()
    }
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    const fiber = Effect.runFork(
      serveProgram((url) => process.stdout.write(`${url}\n`)).pipe(Effect.provide(layer)),
    )
    interrupt = () => Effect.runFork(Fiber.interrupt(fiber))
    if (stopping) interrupt()
    const exit = await Effect.runPromise(Fiber.await(fiber))
    endProcesses()
    await mcp.stop()
    await shutdownTelemetry()
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      fail(`serve stopped: ${Cause.squash(exit.cause) instanceof Error ? (Cause.squash(exit.cause) as Error).message : Cause.pretty(exit.cause)}`)
    }
  },

  async check(args) {
    if (args.length > 0) usageError("check takes no arguments")
    const { inputs } = serveInputs()
    process.stdout.write(`${protocolUrl(inputs.listenHost, inputs.listenPort)}\n`)
  },

  async migrate(args) {
    const { inputs } = loadInputsOrExit("migrate")
    const path = databasePath(inputs.stateDir)
    if (args.length === 1 && args[0] === "status") {
      const db = openDatabaseReadonly(path)
      try {
        const status = readMigrationStatus(db, migrations())
        for (const entry of status.applied) process.stdout.write(`applied  ${entry.name}  ${formatTime(entry.appliedAt)}\n`)
        for (const migration of status.pending) process.stdout.write(`pending  ${migration.name}\n`)
      } finally {
        db?.close()
      }
      return
    }
    if (args.length > 0) usageError("migrate takes no arguments but status")
    const db = openDatabase(path)
    try {
      const applied = applyMigrations(db, migrations())
      for (const migration of applied) process.stdout.write(`applied  ${migration.name}\n`)
      if (applied.length === 0) process.stdout.write("no pending migrations\n")
    } finally {
      db.close()
    }
  },

  async db(args) {
    if (args.length !== 2 || args[0] !== "dump") usageError("db dump takes one path")
    const { inputs } = loadInputsOrExit("db")
    const destination = resolve(args[1]!)
    if (!existsSync(dirname(destination))) fail(`no directory ${dirname(destination)}`)
    openCurrentDatabase(inputs.stateDir).close()
    dumpDatabase(databasePath(inputs.stateDir), destination)
    process.stdout.write(`dumped to ${destination}\n`)
  },

  async owner(args) {
    if (args.length !== 1 || args[0] !== "set-password") usageError("owner takes set-password")
    const { inputs } = loadInputsOrExit("owner")
    const db = openCurrentDatabase(inputs.stateDir)
    try {
      const password = await readSecretLine("New owner password: ")
      if (password.length === 0) fail("the password is empty")
      if (process.stdin.isTTY && (await readSecretLine("Repeat it: ")) !== password) fail("the passwords differ")
      const replacing = hasOwnerPassword(db)
      await setOwnerPassword(db, password, Date.now())
      process.stdout.write(replacing ? "owner password changed; every login was signed out\n" : "owner password set\n")
    } finally {
      db.close()
    }
  },

  async token(args) {
    const [action, ...rest] = args
    const { inputs } = loadInputsOrExit("token")
    const db = openCurrentDatabase(inputs.stateDir)
    try {
      if (action === "create" && rest.length === 1) {
        const result = createApiToken(db, rest[0]!, Date.now())
        if (!result.ok) {
          fail(result.reason === "empty-name" ? "the token name is empty" : `an active token is named ${rest[0]}`)
        } else {
          process.stdout.write(`${result.token}\n`)
        }
      } else if (action === "list" && rest.length === 0) {
        for (const token of listApiTokens(db)) {
          process.stdout.write(`${token.name}\tcreated ${formatTime(token.createdAt)}\tlast used ${formatTime(token.lastUsedAt)}\n`)
        }
      } else if (action === "revoke" && rest.length === 1) {
        if (!revokeApiToken(db, rest[0]!, Date.now())) fail(`no active token is named ${rest[0]}`)
        process.stdout.write(`revoked ${rest[0]}\n`)
      } else {
        usageError("token takes create <name>, list, or revoke <name>")
      }
    } finally {
      db.close()
    }
  },
}

const [name, ...args] = process.argv.slice(2)
if (name === "--version" || name === "version") {
  process.stdout.write(`AsheAgent ${revision}\n`)
} else if (name === undefined || name === "--help" || name === "help") {
  process.stdout.write(usage)
} else {
  const command = commands[name]
  if (command === undefined) usageError(`unknown command ${name}`)
  try {
    await command!(args)
  } catch (error) {
    if (error instanceof MigrationError) fail(error.message)
    throw error
  }
}
