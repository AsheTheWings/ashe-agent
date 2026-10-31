import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { statSync } from "node:fs"
import { join } from "node:path"
import { Client, waitFor } from "./support/cli.ts"
import { models, SessionView, TestServer } from "./support/server.ts"

/** Runs `body` against a fresh in-process server and cleans up. */
const withServer = async (body: (server: TestServer, token: string) => Promise<void>, server = new TestServer()) => {
  try {
    const token = server.token("primary")
    await server.start()
    await body(server, token)
  } finally {
    await server.cleanup()
  }
}

const connect = async (url: string, token: string) => {
  const client = await Client.connect(url)
  const auth = await client.request("auth.authenticate", { token, protocolVersion: 1 })
  if (auth.error !== undefined) throw new Error(auth.error.message)
  return client
}

const createSession = async (client: Client) => {
  const response = await client.request("session.create", {})
  if (response.error !== undefined) throw new Error(response.error.message)
  return response.result.session.id as string
}


const runIds = (view: SessionView) =>
  view.events.filter((event) => event.event.type === "RUN_STARTED").map((event) => event.event.runId as string)

const finishedRuns = (view: SessionView) => view.events.filter((event) => event.event.type === "RUN_FINISHED").length

const said = (view: SessionView) =>
  view.events.filter((event) => event.event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.event.delta as string)

/** The session's rows in the events, turns, and sessions tables, read from the database file. */
const snapshot = (server: TestServer, id: string) => {
  const db = new Database(server.databasePath, { readonly: true })
  try {
    return JSON.stringify([
      db.query("SELECT * FROM events WHERE session_id = ? ORDER BY seq").all(id),
      db.query("SELECT * FROM turns WHERE session_id = ? ORDER BY position").all(id),
      db.query("SELECT next_seq FROM sessions WHERE id = ?").get(id),
      db.query("SELECT position, run_id, kind, body FROM window_items WHERE session_id = ? ORDER BY position").all(id),
      db.query("SELECT position, kind, body FROM waiting_input WHERE session_id = ? ORDER BY position").all(id),
    ])
  } finally {
    db.close()
  }
}

/** Runs `sql` on the server's database file through a separate connection. */
const execute = (server: TestServer, sql: string) => {
  const db = new Database(server.databasePath)
  try {
    db.run(sql)
  } finally {
    db.close()
  }
}

describe("sessions", () => {
  test("creation refuses a working directory, gives each session its own directory, and sessions and models are listed", async () => {
    await withServer(async (server, token) => {
      const client = await connect(server.url, token)
      expect((await client.request("session.create", { cwd: server.dir })).error.code).toBe(-32602)
      expect((await client.request("session.create", { model: "other/model" })).error.code).toBe(-32007)
      const id = await createSession(client)
      const sessionDir = join(server.sessionsDir, id)
      expect(statSync(sessionDir).isDirectory()).toBe(true)
      expect(statSync(sessionDir).mode & 0o777).toBe(0o700)
      const listed = (await client.request("session.list")).result.sessions
      expect(listed.map((session: any) => session.id)).toEqual([id])
      expect(listed[0]).toMatchObject({ sessionDir, model: models[0]!.id, agent: null, running: false, lastSeq: 2 })
      const view = await SessionView.open(server.url, token, id)
      await view.waitFor("the created event", (v) => v.types().includes("SESSION_CREATED"))
      expect(view.events[0].event.sessionDir).toBe(sessionDir)
      expect((await client.request("models.list")).result).toEqual({
        models: [
          { id: "test/first", name: "test/first", contextLimit: 400_000, imageInput: false, reasoningEfforts: ["low", "high"], reasoningEffort: "low" },
          { id: "test/second", name: "test/second", contextLimit: 300_000, imageInput: true, reasoningEfforts: [], reasoningEffort: null },
        ],
        defaultModel: "test/first",
      })
    })
  })

  test("events are numbered from 1 and a subscription resumes after a sequence number", async () => {
    await withServer(async (server, token) => {
      const client = await connect(server.url, token)
      const id = await createSession(client)
      const view = await SessionView.open(server.url, token, id)
      await client.request("session.input", { sessionId: id, text: "one" })
      server.script.release("one")
      await view.waitFor("the turn to finish", (v) => finishedRuns(v) === 1)
      expect(view.events.map((event) => event.seq)).toEqual(view.events.map((_, index) => index + 1))
      const resumed = await SessionView.open(server.url, token, id, 3)
      await resumed.waitFor("the replay", (v) => v.lastSeq === view.lastSeq)
      expect(resumed.events).toEqual(view.events.slice(3))
    })
  })
})

describe("two clients on one session", () => {
  test("both see the same events; a disconnect leaves the turn running; resuming has no gap or duplicate", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const a = await SessionView.open(server.url, token, id)
      const b = await SessionView.open(server.url, token, id)
      await a.client.request("session.input", { sessionId: id, text: "long" })
      await a.waitFor("the turn to start", (v) => v.types().includes("RUN_STARTED"))
      const seenByA = a.lastSeq
      a.client.close()
      await a.client.waitClosed()
      await control.request("session.input", { sessionId: id, text: "more" })
      server.script.release("long")
      await b.waitFor("the turn to finish", (v) => finishedRuns(v) === 1)
      expect(b.texts()).toEqual(["echo: long", "steered: more"])
      const again = await SessionView.open(server.url, token, id, seenByA)
      await again.waitFor("the replay", (v) => v.lastSeq === b.lastSeq)
      expect([...a.events, ...again.events]).toEqual(b.events)
      expect(again.received).toEqual(b.events.map((event) => event.seq).filter((seq) => seq > seenByA))
    })
  })
})

describe("input during turns", () => {
  test("input starts a turn, steers it by default, queues in queue mode, and names its sender", async () => {
    await withServer(async (server, token) => {
      const other = server.token("secondary")
      const control = await connect(server.url, token)
      const second = await connect(server.url, other)
      const id = await createSession(control)
      const view = await SessionView.open(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "first" })
      await view.waitFor("the first turn", (v) => v.texts().includes("echo: first"))
      await second.request("session.input", { sessionId: id, text: "queued one", mode: "queue" })
      await control.request("session.input", { sessionId: id, text: "queued two", mode: "queue" })
      await second.request("session.input", { sessionId: id, text: "steer" })
      await view.waitFor("the steered input", (v) => v.texts().includes("steered: steer"))
      expect(runIds(view)).toHaveLength(1)
      server.script.release("first")
      await view.waitFor("the first queued turn", (v) => v.texts().includes("echo: queued one"))
      server.script.release("queued one")
      await view.waitFor("the second queued turn", (v) => v.texts().includes("echo: queued two"))
      server.script.release("queued two")
      await view.waitFor("three finished turns", (v) => finishedRuns(v) === 3)
      const inputs = view.events.filter((event) => event.event.type === "INPUT_RECEIVED").map((event) => event.event)
      expect(inputs.map((input) => input.text)).toEqual(["first", "steer", "queued one", "queued two"])
      const senders = new Map(inputs.map((input) => [input.text, input.sender]))
      expect(senders.get("first").tokenId).not.toBe(senders.get("steer").tokenId)
      expect(senders.get("steer")).toMatchObject({ kind: "token", name: "secondary" })
    })
  })

  test("steered input arriving after the last step boundary starts the next turn", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const view = await SessionView.open(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "hold" })
      await view.waitFor("the turn", (v) => v.texts().includes("echo: hold"))
      server.script.release("hold")
      await waitFor("the last step boundary", () => (server.script.pastLastBoundary.has("hold") ? true : undefined), 10_000)
      await control.request("session.input", { sessionId: id, text: "late" })
      expect(finishedRuns(view)).toBe(0)
      server.script.release("hold end")
      server.script.release("late")
      await view.waitFor("the late input's turn", (v) => finishedRuns(v) === 2)
      expect(runIds(view)).toHaveLength(2)
      expect(view.texts()).toEqual(["echo: hold", "echo: late"])
    })
  })

  test("an input whose turn cannot start stays waiting and starts the next turn with later input", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      execute(server, "CREATE TRIGGER fail_turn BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT, 'injected'); END")
      expect((await control.request("session.input", { sessionId: id, text: "never" })).result.inputId).toBeString()
      execute(server, "DROP TRIGGER fail_turn")
      const view = await SessionView.open(server.url, token, id)
      await view.waitFor("the error", (v) => v.types().includes("SESSION_ERROR"))
      expect(view.events.find((event) => event.event.type === "SESSION_ERROR")!.event).toMatchObject({ code: "turn_start_failed" })
      await control.request("session.input", { sessionId: id, text: "after" })
      server.script.release("never")
      await view.waitFor("the turn", (v) => finishedRuns(v) === 1)
      expect(view.types().slice(0, 4)).toEqual(["SESSION_CREATED", "CHECKPOINT_WINDOW_SEEDED", "INPUT_WAITING", "SESSION_ERROR"])
      expect(view.texts()).toEqual(["echo: never"])
      const started = view.events.find((event) => event.event.type === "RUN_STARTED")!.event
      expect(started).toMatchObject({ cause: "user" })
      expect(started.type === "RUN_STARTED" && started.userMessageIds).toHaveLength(2)
    })
  })

  test("cancel ends the running turn with a cancelled event", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const view = await SessionView.open(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "cancel me" })
      await view.waitFor("the turn", (v) => v.texts().includes("echo: cancel me"))
      expect((await control.request("session.cancel", { sessionId: id })).result).toEqual({})
      await view.waitFor("the cancelled event", (v) =>
        v.events.some((event) => event.event.type === "RUN_FINISHED" && event.event.outcome.type === "cancelled"),
      )
      expect((await control.request("session.cancel", { sessionId: id })).error.code).toBe(-32005)
    })
  })
})

describe("restart", () => {
  test("sessions survive, running turns end interrupted, unanswered asks are withdrawn, and input is accepted", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const view = await SessionView.open(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "ask before restart" })
      await view.waitFor("the permission request", (v) => v.types().includes("PERMISSION_REQUESTED"))
      const before = view.lastSeq
      await server.restart()
      const after = await SessionView.open(server.url, token, id, before)
      await after.waitFor("the interrupted event", (v) => v.types().includes("RUN_INTERRUPTED"))
      expect(after.types()).toEqual(["PERMISSION_WITHDRAWN", "RUN_INTERRUPTED"])
      expect(after.events[0].event.reason).toBe("restart")
      const client = await connect(server.url, token)
      const listed = (await client.request("session.list")).result.sessions
      expect(listed[0]).toMatchObject({ id, sessionDir: join(server.sessionsDir, id), running: false })
      await client.request("session.input", { sessionId: id, text: "after restart" })
      server.script.release("after restart")
      await after.waitFor("the new turn to finish", (v) => finishedRuns(v) === 1)
    })
  })

  test("an ended turn withdraws its unanswered asks, leaving none for a restart", async () => {
    await withServer(async (server, token) => {
      const control = await connect(server.url, token)
      const id = await createSession(control)
      const view = await SessionView.open(server.url, token, id)
      await control.request("session.input", { sessionId: id, text: "ask then cancel" })
      await view.waitFor("the permission request", (v) => v.types().includes("PERMISSION_REQUESTED"))
      await control.request("session.cancel", { sessionId: id })
      await view.waitFor("the cancelled event", (v) => finishedRuns(v) === 1)
      const requested = view.events.find((event) => event.event.type === "PERMISSION_REQUESTED")
      expect(view.events.slice(-2).map((event) => event.event)).toMatchObject([
        { type: "PERMISSION_WITHDRAWN", requestId: requested.event.requestId, reason: "canceled" },
        { type: "RUN_FINISHED", outcome: { type: "cancelled" } },
      ])
      await server.restart()
      const after = await SessionView.open(server.url, token, id)
      await after.waitFor("the replay", (v) => v.lastSeq === view.lastSeq)
      expect(after.events).toEqual(view.events)
    })
  })

  test("an always grant still allows its call without an ask, and an ungranted call still follows the rules", async () => {
    await withServer(
      async (server, token) => {
        const control = await connect(server.url, token)
        const id = await createSession(control)
        const view = await SessionView.open(server.url, token, id)
        await control.request("session.input", { sessionId: id, text: "ask ls a" })
        await view.waitFor("the permission request", (v) => v.types().includes("PERMISSION_REQUESTED"))
        const requested = view.events.find((event) => event.event.type === "PERMISSION_REQUESTED")
        const answer = { sessionId: id, requestId: requested.event.requestId, answer: "always" }
        expect((await control.request("permission.answer", answer)).result).toEqual({})
        expect((await control.request("permission.answer", answer)).error.code).toBe(-32006)
        await view.waitFor("the allowed call", (v) => said(v).includes("permission: allowed"))
        server.script.release("ask ls a")
        await view.waitFor("the turn to finish", (v) => finishedRuns(v) === 1)
        await server.restart()
        const client = await connect(server.url, token)
        const after = await SessionView.open(server.url, token, id, view.lastSeq)
        await client.request("session.input", { sessionId: id, text: "ask ls a" })
        await after.waitFor("the granted call", (v) => said(v).includes("permission: allowed"))
        server.script.release("ask ls a")
        await after.waitFor("the granted turn to finish", (v) => finishedRuns(v) === 1)
        await client.request("session.input", { sessionId: id, text: "ask rm a" })
        await after.waitFor("the denied call", (v) => said(v).includes("permission: denied by configuration"))
        server.script.release("ask rm a")
        await after.waitFor("the denied turn to finish", (v) => finishedRuns(v) === 2)
        await client.request("session.input", { sessionId: id, text: "ask ls b" })
        await after.waitFor("the ungranted request", (v) => v.types().includes("PERMISSION_REQUESTED"))
        await client.request("session.cancel", { sessionId: id })
        await after.waitFor("the cancelled turn", (v) => finishedRuns(v) === 3)
      },
      new TestServer({ shell: { "*": "ask", "rm *": "deny" } }),
    )
  })
})

describe("fork and rewind", () => {
  /** A session with three finished turns, "t1" to "t3", and a view of it. */
  const threeTurns = async (server: TestServer, token: string) => {
    const control = await connect(server.url, token)
    const id = await createSession(control)
    const view = await SessionView.open(server.url, token, id)
    for (const [index, text] of ["t1", "t2", "t3"].entries()) {
      await control.request("session.input", { sessionId: id, text })
      server.script.release(text)
      await view.waitFor(`turn ${text}`, (v) => finishedRuns(v) === index + 1)
    }
    return { control, id, view }
  }

  test("fork copies through a user turn and leaves the source unchanged; both are refused while a turn runs", async () => {
    await withServer(async (server, token) => {
      const { control, id, view } = await threeTurns(server, token)
      await control.request("session.setModel", { sessionId: id, model: models[1]!.id })
      const [, second] = runIds(view)
      const sourceBefore = [...view.events]
      const forked = (await control.request("session.fork", { sessionId: id, runId: second })).result.session
      expect(forked).toMatchObject({ model: models[1]!.id, sessionDir: join(server.sessionsDir, forked.id) })
      expect(forked.sessionDir).not.toBe(sourceBefore[0].event.sessionDir)
      expect(statSync(forked.sessionDir).isDirectory()).toBe(true)
      const copy = await SessionView.open(server.url, token, forked.id)
      await copy.waitFor("the copy", (v) => v.lastSeq === forked.lastSeq)
      expect(copy.texts()).toEqual(["echo: t1", "echo: t2"])
      expect(copy.events[0].event.forkedFrom).toEqual({ sessionId: id, runId: second })
      const replay = await SessionView.open(server.url, token, id)
      await replay.waitFor("the source", (v) => v.lastSeq === view.lastSeq)
      expect(replay.events).toEqual(view.events)

      await control.request("session.input", { sessionId: id, text: "running" })
      await view.waitFor("the running turn", (v) => v.texts().includes("echo: running"))
      expect((await control.request("session.fork", { sessionId: id })).error.code).toBe(-32005)
      expect((await control.request("session.rewind", { sessionId: id, runId: second })).error.code).toBe(-32005)
      server.script.release("running")
    })
  })

  test("a fork after a rewind copies only its turns' events and the source's settings", async () => {
    await withServer(async (server, token) => {
      const { control, id, view } = await threeTurns(server, token)
      const [first, second] = runIds(view)
      await control.request("session.rewind", { sessionId: id, runId: second, text: "t2 again" })
      server.script.release("t2 again")
      await view.waitFor("the rerun turn", (v) => finishedRuns(v) === 2)
      await control.request("session.setModel", { sessionId: id, model: models[1]!.id })
      for (const through of [first, undefined]) {
        const forked = (await control.request("session.fork", { sessionId: id, ...(through === undefined ? {} : { runId: through }) }))
          .result.session
        const copy = await SessionView.open(server.url, token, forked.id)
        await copy.waitFor("the copy", (v) => v.lastSeq === forked.lastSeq)
        expect(copy.types()).not.toContain("SESSION_REWOUND")
        expect(copy.types()).not.toContain("MODEL_CHANGED")
        expect(copy.events[0].event.model).toBe(models[1]!.id)
        expect(copy.texts()).toEqual(through === undefined ? ["echo: t1", "echo: t2 again"] : ["echo: t1"])
        expect(runIds(copy)).toEqual(through === undefined ? runIds(view) : [first!])
      }
    })
  })

  test("a rewind reaches a live and a disconnected client, also after a restart, without reused numbers", async () => {
    await withServer(async (server, token) => {
      const { control, id, view } = await threeTurns(server, token)
      const away = await SessionView.open(server.url, token, id)
      await away.waitFor("the history", (v) => v.lastSeq === view.lastSeq)
      const awaySeq = away.lastSeq
      away.client.close()
      await away.client.waitClosed()
      const [, second] = runIds(view)
      const highest = view.lastSeq
      expect((await control.request("session.rewind", { sessionId: id, runId: second, text: "t2 edited" })).result).toEqual({})
      server.script.release("t2 edited")
      await view.waitFor("the rerun turn", (v) => finishedRuns(v) === 2)
      expect(view.texts()).toEqual(["echo: t1", "echo: t2 edited"])
      const rewound = view.events.find((event) => event.event.type === "SESSION_REWOUND")
      expect(rewound.seq).toBe(highest + 1)

      for (const restart of [false, true]) {
        if (restart) await server.restart()
        const back = await SessionView.open(server.url, token, id, awaySeq)
        await back.waitFor("the resume", (v) => v.received.includes(view.lastSeq))
        const merged = [...away.events.filter((event) => event.seq < rewound.event.firstRemovedSeq), ...back.events.slice(1)]
        expect(back.events[0].event.type).toBe("SESSION_REWOUND")
        expect(merged.map((event) => event.seq)).toEqual(view.events.filter((e) => e.event.type !== "SESSION_REWOUND").map((e) => e.seq))
        const fresh = await SessionView.open(server.url, token, id)
        await fresh.waitFor("the full replay", (v) => v.lastSeq === view.lastSeq)
        expect(fresh.texts()).toEqual(["echo: t1", "echo: t2 edited"])
        const seqs = fresh.events.map((event) => event.seq)
        expect(new Set(seqs).size).toBe(seqs.length)
        expect(seqs.filter((seq) => seq > rewound.event.firstRemovedSeq - 1).every((seq) => seq > highest)).toBe(true)
      }
    })
  })

  test("a rewind without input reruns the removed turn's input", async () => {
    await withServer(async (server, token) => {
      const { control, id, view } = await threeTurns(server, token)
      const [, , third] = runIds(view)
      await control.request("session.rewind", { sessionId: id, runId: third })
      await view.waitFor("the rerun", (v) => v.texts().filter((text) => text === "echo: t3").length === 1 && v.types().at(-1) !== "SESSION_REWOUND")
      expect(view.texts()).toEqual(["echo: t1", "echo: t2", "echo: t3"])
      server.script.release("t3")
    })
  })

  test("a rewind whose transaction fails leaves history, counter, and events as before", async () => {
    const server = new TestServer()
    try {
      const token = server.token("primary")
      await server.start()
      const turns = await threeTurns(server, token)
      const { id, view } = turns
      let control = turns.control
      const [, second] = runIds(view)
      const before = snapshot(server, id)
      const faults = [
        // After the deletion: the counter update fails.
        "CREATE TRIGGER fail_rewind BEFORE UPDATE OF next_seq ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END",
        // After the counter update: inserting the rewound event fails.
        "CREATE TRIGGER fail_rewind BEFORE INSERT ON events WHEN NEW.body LIKE '%SESSION_REWOUND%' BEGIN SELECT RAISE(ABORT, 'injected'); END",
        // After the rewound event: storing the rerun input fails.
        "CREATE TRIGGER fail_rewind BEFORE INSERT ON waiting_input BEGIN SELECT RAISE(ABORT, 'injected'); END",
      ]
      for (const fault of faults) {
        execute(server, fault)
        const response = await control.request("session.rewind", { sessionId: id, runId: second })
        expect(response.error.code).toBe(-32603)
        await server.restart()
        execute(server, "DROP TRIGGER fail_rewind")
        expect(snapshot(server, id)).toBe(before)
        const replay = await SessionView.open(server.url, token, id)
        await replay.waitFor("the replay", (v) => v.lastSeq === view.lastSeq)
        expect(replay.texts()).toEqual(["echo: t1", "echo: t2", "echo: t3"])
        control = await connect(server.url, token)
      }
      // A rewind whose rerun turn cannot start keeps its input waiting, and a restart starts it.
      execute(server, "CREATE TRIGGER fail_turn BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT, 'injected'); END")
      expect((await control.request("session.rewind", { sessionId: id, runId: second })).result).toEqual({})
      await server.restart()
      execute(server, "DROP TRIGGER fail_turn")
      await server.restart()
      const rerun = await SessionView.open(server.url, token, id)
      await rerun.waitFor("the rerun turn", (v) => v.texts().includes("echo: t2") && v.types().filter((type) => type === "RUN_STARTED").length === 2)
      expect(rerun.texts()).toEqual(["echo: t1", "echo: t2"])
    } finally {
      await server.cleanup()
    }
  })
})
