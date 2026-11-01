/** A turn that cannot go on; its message and code become the turn's error event. */
export class TurnFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}
