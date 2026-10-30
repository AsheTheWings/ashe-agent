import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { CodeMode, Tool } from "../src/index.js"

// A program whose one tool call waits until the test answers it, with that wait uncounted or counted.
const waitingRun = (uncounted: boolean) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const answer = yield* Deferred.make<string>()
    const wait = Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(answer))
    const ask = Tool.make({
      description: "Waits for an answer",
      input: Schema.Struct({}),
      output: Schema.String,
      execute: () => (uncounted ? CodeMode.uncounted(wait) : wait),
    })
    const runtime = CodeMode.make({ tools: { ask }, limits: { timeoutMs: 1_000 } })
    const fiber = yield* Effect.forkChild(runtime.execute(`const answer = await tools.ask({}); return answer`))
    yield* Deferred.await(entered)
    yield* TestClock.adjust("1 hour")
    yield* Deferred.succeed(answer, "yes")
    return yield* Fiber.join(fiber)
  }).pipe(Effect.provide(TestClock.layer()))

describe("active time", () => {
  test("a wait marked uncounted uses none of the time limit", async () => {
    expect(await Effect.runPromise(waitingRun(true))).toMatchObject({ ok: true, value: "yes" })
  })

  test("an unmarked wait counts toward the time limit", async () => {
    expect(await Effect.runPromise(waitingRun(false))).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } })
  })

  test.each([
    [600, { ok: true, value: "slow" }],
    [1_200, { ok: false, error: { kind: "TimeoutExceeded" } }],
  ])("after an uncounted wait, a %dms call counts toward a 1000ms limit", async (slowMs, expected) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const answer = yield* Deferred.make<string>()
        const ask = Tool.make({
          description: "Waits for an answer",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => CodeMode.uncounted(Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(answer))),
        })
        const slow = Tool.make({
          description: "Takes time",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.as(Effect.sleep(slowMs), "slow"),
        })
        const runtime = CodeMode.make({ tools: { ask, slow }, limits: { timeoutMs: 1_000 } })
        const fiber = yield* Effect.forkChild(runtime.execute(`await tools.ask({}); return await tools.slow({})`))
        yield* Deferred.await(entered)
        yield* TestClock.adjust("1 hour")
        yield* Deferred.succeed(answer, "yes")
        yield* TestClock.adjust(slowMs)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(result).toMatchObject(expected)
  })
})
