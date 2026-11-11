import { Redacted, Result } from "effect"
import { parseOtlpHeaders } from "../../../harness/src/telemetry/headers.ts"
import { processSources, readDiskFile } from "@ashe-agent/harness/inputs"
import { resolveInputs, type Inputs, type Sources } from "@ashe-agent/harness/inputs/resolve"

export class WebInputError extends Error {
  constructor(readonly issues: ReadonlyArray<{ readonly input: string; readonly problem: string }>) {
    super(`invalid web inputs\n${issues.map((issue) => `  ${issue.input}: ${issue.problem}`).join("\n")}`)
    this.name = "WebInputError"
  }
}

export type WebConfig = {
  readonly profile: "development" | "production"
  readonly inputs: Inputs<"webServe">
  readonly observerToken: string | null
  readonly otlpHeaders: Redacted.Redacted<Record<string, string>>
}

export const loadWebConfig = (sources: Sources = processSources()): WebConfig => {
  const resolution = resolveInputs("webServe", sources)
  if (!resolution.ok) throw new WebInputError(resolution.issues)
  const { inputs, profile } = resolution
  let observerToken: string | null = null
  if (inputs.webObserverCredentialFile !== null) {
    const read = readDiskFile(inputs.webObserverCredentialFile)
    if (read.kind !== "ok" || (read.mode & 0o077) !== 0) {
      throw new WebInputError([{ input: "ASHE_AGENT_WEB_OBSERVER_CREDENTIAL_FILE", problem: "must be a protected readable file" }])
    }
    observerToken = read.text.trim()
  }
  const parsedHeaders = inputs.otlpHeaders == null ? Result.succeed({}) : parseOtlpHeaders(Redacted.value(inputs.otlpHeaders))
  if (Result.isFailure(parsedHeaders)) {
    throw new WebInputError([{ input: "ASHE_AGENT_OTLP_HEADERS_FILE", problem: parsedHeaders.failure }])
  }
  return {
    profile,
    inputs,
    observerToken,
    otlpHeaders: Redacted.make(parsedHeaders.success),
  }
}
