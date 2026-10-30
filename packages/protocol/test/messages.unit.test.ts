import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { ClientRequest, ServerMessage, unsupportedVersionError, ErrorCode } from "../src/index.ts"

const decodeRequest = Schema.decodeUnknownResult(ClientRequest)
const decodeServer = Schema.decodeUnknownResult(ServerMessage)

describe("client requests", () => {
  test("a request decodes with its method's params", () => {
    const result = decodeRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "session.input",
      params: { sessionId: "s1", text: "hello", mode: "queue" },
    })
    expect(Result.isSuccess(result)).toBe(true)
  })

  test("unknown fields are ignored", () => {
    const result = decodeRequest({
      jsonrpc: "2.0",
      id: "a",
      method: "session.cancel",
      params: { sessionId: "s1", extra: true },
      extra: 1,
    })
    expect(Result.isSuccess(result) && result.success).toEqual({
      jsonrpc: "2.0",
      id: "a",
      method: "session.cancel",
      params: { sessionId: "s1" },
    })
  })

  test("params of another method are refused", () => {
    const result = decodeRequest({ jsonrpc: "2.0", id: 1, method: "session.setModel", params: { sessionId: "s1" } })
    expect(Result.isFailure(result)).toBe(true)
  })

  test("an unknown method is refused", () => {
    expect(Result.isFailure(decodeRequest({ jsonrpc: "2.0", id: 1, method: "session.drop", params: {} }))).toBe(true)
  })

  test("a method without params fields accepts omitted or object params and refuses others", () => {
    const request = (params?: unknown) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "models.list",
      ...(params === undefined ? {} : { params }),
    })
    expect(Result.isSuccess(decodeRequest(request()))).toBe(true)
    expect(Result.isSuccess(decodeRequest(request({})))).toBe(true)
    expect(Result.isSuccess(decodeRequest(request({ future: 1 })))).toBe(true)
    for (const params of [true, 1, "x", [], null]) {
      expect(Result.isFailure(decodeRequest(request(params)))).toBe(true)
    }
  })

  test("a method with params fields requires params", () => {
    expect(Result.isFailure(decodeRequest({ jsonrpc: "2.0", id: 1, method: "session.cancel" }))).toBe(true)
  })
})

describe("server messages", () => {
  const event = {
    sessionId: "s1",
    seq: 3,
    timestamp: 1_700_000_000_000,
    event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hi" },
  }
  const error = { code: -32004, message: "not found" }

  test("a session event notification decodes", () => {
    expect(Result.isSuccess(decodeServer({ jsonrpc: "2.0", method: "session.event", params: event }))).toBe(true)
  })

  test("a notification with an id is refused", () => {
    expect(Result.isFailure(decodeServer({ jsonrpc: "2.0", id: 1, method: "session.event", params: event }))).toBe(true)
  })

  test("a response holding both result and error is refused", () => {
    expect(Result.isFailure(decodeServer({ jsonrpc: "2.0", id: 1, result: {}, error }))).toBe(true)
    expect(Result.isSuccess(decodeServer({ jsonrpc: "2.0", id: 1, result: {} }))).toBe(true)
    expect(Result.isSuccess(decodeServer({ jsonrpc: "2.0", id: null, error }))).toBe(true)
  })

  test("an unsupported version error names the supported versions", () => {
    const error = unsupportedVersionError([1, 2])
    expect(error.code).toBe(ErrorCode.unsupportedVersion)
    expect(error.data?.supportedVersions).toEqual([1, 2])
    expect(error.message).toContain("1, 2")
    expect(Result.isSuccess(decodeServer({ jsonrpc: "2.0", id: 1, error }))).toBe(true)
  })
})
