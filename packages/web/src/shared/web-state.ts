/**
 * The built-in web state protocol. Versions guard saved browser data and
 * the WebSocket handshake; the harness protocol remains separately owned.
 */
export const WEB_PROTOCOL_VERSION = 1 as const
export const WEB_STATE_PATH = "/v1/web-state"
export const WEB_IDENTITY_PATH = "/v1/web/identity"
export const WEB_HEALTH_PATH = "/v1/web/health"
export const WEB_DIAGNOSTICS_PATH = "/v1/web/diagnostics"

export type WebOrganizationPatch = {
  readonly pinned?: boolean
  readonly filed?: boolean
  readonly snoozedUntil?: number | null
  readonly optedOut?: boolean
}

export type WebField = keyof WebOrganizationPatch

export type WebCommand =
  | {
      readonly kind: "organization.set"
      readonly operationId: string
      readonly sessionId: string
      readonly patch: WebOrganizationPatch
      /** Set when the client saw this exact observed row; a mismatch refuses the command. */
      readonly expectedRevision?: number
    }
  | {
      readonly kind: "read.set"
      readonly operationId: string
      readonly sessionId: string
      readonly unread: boolean
      /** Required when marking read; mark-unread advances the generation. */
      readonly generation?: number
    }
  | {
      readonly kind: "file.manual"
      readonly operationId: string
      readonly sessionId: string
      /** The freshly reconciled source cursor the caller acted on. */
      readonly observedCursor: number
      readonly observedRevision: number
    }
  | {
      readonly kind: "undo"
      readonly operationId: string
      readonly undoOf: string
    }

export type WebSessionState = {
  readonly sessionId: string
  readonly pinned: boolean
  readonly filed: boolean
  readonly snoozedUntil: number | null
  readonly unread: boolean
  readonly readGeneration: number
  readonly working: boolean
  readonly needsHuman: boolean
  readonly available: boolean
  readonly lastActivityAt: number
  readonly lastSubmissionAt: number
  readonly lastReturnAt: number
  readonly sourceCursor: number
  readonly optedOut: boolean
  /** The row's revision; an operation returns the revision it produced. */
  readonly revision: number
}

export type WebSnapshot = {
  readonly type: "web.snapshot"
  readonly protocolVersion: number
  readonly revision: number
  readonly principal: string
  readonly harnessId: string
  readonly sessions: ReadonlyArray<WebSessionState>
}

export type WebReceipt = {
  readonly type: "web.receipt"
  readonly operationId: string
  readonly outcome: "confirmed" | "rejected" | "uncertain"
  readonly revision: number
  readonly changed: ReadonlyArray<WebSessionState>
  readonly message?: string
}

export type WebUpdate = {
  readonly type: "web.update"
  readonly revision: number
  readonly changed: ReadonlyArray<WebSessionState>
}

export type WebFailure = {
  readonly type: "web.error"
  readonly code: string
  readonly message: string
}

/** Browser messages: authenticate first, then send commands. */
export type WebClientMessage =
  | { readonly type: "web.authenticate"; readonly token: string; readonly protocolVersion: number }
  | { readonly type: "web.command"; readonly command: WebCommand }
  | { readonly type: "web.snapshot" }
  | { readonly type: "web.operation"; readonly operationId: string }
  | { readonly type: "web.ping" }

export type WebServerMessage = WebSnapshot | WebReceipt | WebUpdate | WebFailure

export type WebIdentity = {
  readonly principal: string
  readonly harnessId: string
  readonly credentialExpiresAt: number | null
}

export type DiagnosticRecord = {
  readonly name: string
  readonly timeUnixNano?: string
  readonly attributes: Readonly<Record<string, string | number | boolean | ReadonlyArray<string>>>
  readonly body?: string
}
