import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

test("the adapted upstream presentation keeps its pinned notice", () => {
  const notice = readFileSync(join(import.meta.dir, "../NOTICE-t3"), "utf8")
  expect(notice).toContain("T3 Code v0.1.6")
  expect(notice).toContain("2359643cffa6ba9ee84d6f2694b935de54a8013e")
  expect(notice).toContain("935d8f2af0c703f9c39517ee57cc4930b19d02d533be930b63f0e82f93614b43")
  expect(notice).toContain("MIT License")
  expect(notice).toContain("Copyright (c) 2026 T3 Tools Inc.")
})

test("the reference compose file names the durable backend contract", () => {
  const compose = readFileSync(join(import.meta.dir, "../../../compose.yaml"), "utf8")
  expect(compose).toContain("command: migrate")
  expect(compose).toContain("web-state:/data")
  expect(compose).toContain("ASHE_AGENT_WEB_OBSERVER_CREDENTIAL_FILE")
  expect(compose).toContain("service_completed_successfully")
})
