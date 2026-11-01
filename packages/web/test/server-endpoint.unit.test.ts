import { expect, test } from "bun:test"
import { serverEndpoint } from "../src/session/server-endpoint.ts"

test("static builds connect to /v1/ws on the page's origin", () => {
  expect(serverEndpoint("https://agent.example", null)).toBe("wss://agent.example/v1/ws")
  expect(serverEndpoint("http://127.0.0.1:8080", null)).toBe("ws://127.0.0.1:8080/v1/ws")
  expect(serverEndpoint("https://[::1]:8443", null)).toBe("wss://[::1]:8443/v1/ws")
})

test("development connects to its configured endpoint independently of the page's origin", () => {
  expect(serverEndpoint("http://client.example:5173", "ws://api.example:7420/v1/ws"))
    .toBe("ws://api.example:7420/v1/ws")
})
