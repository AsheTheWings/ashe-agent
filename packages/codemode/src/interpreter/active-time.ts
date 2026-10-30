import { Clock, Context, Effect, Latch, Option } from "effect"

/**
 * The time limit of the running execution. `pause` stops its clock until
 * the returned resume function is called; the clock runs again once no
 * pause is open. A host call waiting on something outside the program,
 * such as a person's answer, pauses it so the wait uses no program time.
 */
export class ActiveTime extends Context.Service<ActiveTime, { readonly pause: () => () => void }>()(
  "@ashe-agent/codemode/ActiveTime",
) {}

/** Runs `effect` with the execution's clock paused, when the execution has a time limit. */
export const uncounted = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.serviceOption(ActiveTime), (clock) =>
    Option.isNone(clock)
      ? effect
      : Effect.acquireUseRelease(
          Effect.sync(() => clock.value.pause()),
          () => effect,
          (resume) => Effect.sync(resume),
        ),
  )

/**
 * A budget of `budgetMs` milliseconds of active time: `expired` completes
 * once the clock has run that long outside every pause.
 */
export const makeBudget = (budgetMs: number) => {
  const running = Latch.makeUnsafe(true)
  const paused = Latch.makeUnsafe(false)
  let pauses = 0
  const pause = () => {
    let resumed = false
    if (pauses++ === 0) {
      running.closeUnsafe()
      paused.openUnsafe()
    }
    return () => {
      if (resumed) return
      resumed = true
      if (--pauses === 0) {
        paused.closeUnsafe()
        running.openUnsafe()
      }
    }
  }
  const expired = Effect.gen(function* () {
    let remaining = budgetMs
    while (remaining > 0) {
      yield* running.await
      const start = yield* Clock.currentTimeMillis
      const outcome = yield* Effect.raceFirst(
        Effect.as(Effect.sleep(remaining), "expired" as const),
        Effect.as(paused.await, "paused" as const),
      )
      if (outcome === "expired") return
      remaining -= (yield* Clock.currentTimeMillis) - start
    }
  })
  return { clock: ActiveTime.of({ pause }), expired }
}
