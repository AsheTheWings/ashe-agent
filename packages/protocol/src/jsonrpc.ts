import { Schema } from "effect"
import { SessionEvent } from "./events.ts"
import { methodNames, methods, type MethodName } from "./methods.ts"
import { PROTOCOL_VERSIONS } from "./shared.ts"

/** The WebSocket path every protocol connection uses. */
export const PROTOCOL_PATH = "/v1/ws"

/**
 * The HTTP path that starts a GitHub sign-in, with the query parameters
 * `origin`, the client's origin, and `challenge`, the base64url SHA-256 of
 * the client's verifier.
 */
export const SIGN_IN_START_PATH = "/v1/auth/github/start"

/** The HTTP path GitHub returns the browser to during a sign-in. */
export const SIGN_IN_CALLBACK_PATH = "/v1/auth/github/callback"

const JsonRpc = Schema.Literal("2.0")

/** Request ids are strings or integers; a response to an unidentifiable request has id null. */
export const RequestId = Schema.Union([Schema.String, Schema.Int])

export type RequestId = typeof RequestId.Type

/** A key that must be absent: JSON-RPC keeps `result`, `error`, and a notification's `id` exclusive. */
const Absent = Schema.optionalKey(Schema.Never)

/** Any JSON-RPC request, before its method's params are checked. */
export const AnyRequest = Schema.Struct({
  jsonrpc: JsonRpc,
  id: RequestId,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
})

export type AnyRequest = typeof AnyRequest.Type

/** Methods whose params define no fields; their requests may omit `params`. */
const withoutParams = new Set<MethodName>(["models.list", "agents.list", "session.list"])

const requestOf = <M extends MethodName>(name: M) => {
  const params = methods[name].params
  return Schema.Struct({
    jsonrpc: JsonRpc,
    id: RequestId,
    method: Schema.Literal(name),
    params: withoutParams.has(name) ? Schema.optionalKey(params) : params,
  })
}

/** Every request a client may send, each with its method's params. */
export const ClientRequest = Schema.Union(methodNames.map(requestOf))

export type ClientRequest = typeof ClientRequest.Type

/** Error codes: JSON-RPC 2.0's own, then this protocol's in the server-defined range. */
export const ErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  unsupportedVersion: -32000,
  unauthenticated: -32001,
  authenticationFailed: -32002,
  notFound: -32004,
  conflict: -32005,
  alreadyResolved: -32006,
  invalidInput: -32007,
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export const ErrorObject = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optionalKey(
    Schema.Struct({
      /** Present on `unsupportedVersion`: the versions the server supports. */
      supportedVersions: Schema.optionalKey(Schema.Array(Schema.Int)),
    }),
  ),
})

export type ErrorObject = typeof ErrorObject.Type

export const SuccessResponse = Schema.Struct({
  jsonrpc: JsonRpc,
  id: RequestId,
  result: Schema.Unknown,
  error: Absent,
})

export const ErrorResponse = Schema.Struct({
  jsonrpc: JsonRpc,
  id: Schema.NullOr(RequestId),
  error: ErrorObject,
  result: Absent,
})

export const SessionEventNotification = Schema.Struct({
  jsonrpc: JsonRpc,
  method: Schema.Literal("session.event"),
  params: SessionEvent,
  id: Absent,
})

/** Every message a server sends. */
export const ServerMessage = Schema.Union([SuccessResponse, ErrorResponse, SessionEventNotification])

export type ServerMessage = typeof ServerMessage.Type

export const unsupportedVersionError = (supported: ReadonlyArray<number> = PROTOCOL_VERSIONS): ErrorObject => ({
  code: ErrorCode.unsupportedVersion,
  message: `unsupported protocol version; supported: ${supported.join(", ")}`,
  data: { supportedVersions: [...supported] },
})
