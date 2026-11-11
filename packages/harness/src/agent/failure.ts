/** A turn that cannot go on; its message and code become the turn's error event. */
export class TurnFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

/** A session or persistence integrity failure; it stops execution rather than becoming a tool result. */
export class IntegrityFailure extends TurnFailure {
  constructor(message: string, code = "state_integrity_failed") {
    super(message, code)
  }
}
