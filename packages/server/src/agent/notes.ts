/** Texts the harness gives the model and clients: notes, and the results of tool calls that did not finish. */

const effects = "Files, processes, and other effects of turns outside this history may persist on the system."

/** The note of a fork's first model call. */
export const forkNote = (source: string, target: string) =>
  `This session was forked: session \`${target}\` is a copy of session \`${source}\` through the turns above. ${effects}`

/** The note of the first model call after a rewind. */
export const rewindNote = () =>
  `The owner rewound this session: later turns were removed from the conversation, and the next input starts again from here. ${effects}`

/** The text of a failed result for a call that ended without its own result. */
export const unfinishedResult = (outcome: "canceled" | "interrupted" | "failed", started: boolean) => {
  const ended =
    outcome === "canceled" ? "was canceled" : outcome === "interrupted" ? "was interrupted by a server stop" : "failed when its turn failed"
  return started
    ? `The tool call ${ended} after it started; it may have had effects.`
    : `The tool call ${ended} before it started.`
}

/**
 * The note of a turn whose catalogs differ from those of the session's
 * first message, naming each changed catalog as it now stands.
 */
export const catalogNote = (changes: ReadonlyArray<{ readonly name: string; readonly catalog: string | null }>) =>
  [
    "These catalogs changed since the start of this session; use them as they stand now.",
    ...changes.map(({ name, catalog }) => (catalog === null ? `# ${name}\n\nNone.` : `# ${name}\n\n${catalog.trim()}`)),
  ].join("\n\n")
