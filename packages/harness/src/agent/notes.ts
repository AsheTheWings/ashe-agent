/** Texts the harness gives the model and clients for tool calls that did not finish. */

/** The text of a failed result for a call that ended without its own result. */
export const unfinishedResult = (outcome: "canceled" | "interrupted" | "failed", started: boolean) => {
  const ended =
    outcome === "canceled" ? "was canceled" : outcome === "interrupted" ? "was interrupted by a server stop" : "failed when its turn failed"
  return started
    ? `The tool call ${ended} after it started; it may have had effects.`
    : `The tool call ${ended} before it started.`
}

/** The note an unfinished `execute` call's result carries: the tool calls its program had finished. */
export const programCallsNote = (finished: ReadonlyArray<{ readonly tool: string; readonly outcome: string }>) =>
  finished.length === 0
    ? "Its program had finished no tool calls."
    : `Its program had finished these tool calls, in order: ${finished.map(({ tool, outcome }) => `${tool} (${outcome})`).join(", ")}.`
