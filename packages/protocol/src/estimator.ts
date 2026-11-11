import type { ContributionMeasurement, Measurement } from "./semantic.ts"

export const ESTIMATOR_METHOD_VERSION = 1
/** Characters per estimated text token. */
export const ESTIMATOR_CHARACTERS_PER_TOKEN = 4
/** The default allowance of one model-facing image. */
export const ESTIMATOR_IMAGE_TOKENS = 1_500
/** The default allowance of one native PDF document. */
export const ESTIMATOR_PDF_TOKENS = 2_000

export type EstimatorContribution =
  | {
      readonly position: number
      readonly kind: "text"
      readonly text: string
      readonly representationIds?: ReadonlyArray<string>
    }
  | {
      readonly position: number
      readonly kind: "structured"
      readonly value: unknown
      readonly representationIds?: ReadonlyArray<string>
    }
  | {
      readonly position: number
      readonly kind: "image"
      readonly count?: number
      readonly representationIds?: ReadonlyArray<string>
    }
  | {
      readonly position: number
      readonly kind: "native-pdf"
      readonly count?: number
      readonly representationIds?: ReadonlyArray<string>
    }
  | {
      readonly position: number
      readonly kind: "unavailable"
      readonly reason: string
      readonly representationIds?: ReadonlyArray<string>
    }

export interface EstimatorOptions {
  readonly imageTokens?: number
  readonly pdfTokens?: number
  readonly purpose?: "execution" | "analysis"
}

/** JSON with object keys sorted, so equivalent structured input has one estimate. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`
    ).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/** The shared estimate of plain text, before any contribution metadata. */
export const estimateText = (text: string) => Math.ceil(text.length / ESTIMATOR_CHARACTERS_PER_TOKEN)

/** The shared estimate of structured input through canonical JSON. */
export const estimateStructured = (value: unknown) => estimateText(canonicalJson(value))

/** Runs a separate, explicitly labelled analysis without changing execution policy. */
export const analyzeContributions = (
  contributions: ReadonlyArray<EstimatorContribution>,
  options: Omit<EstimatorOptions, "purpose"> = {},
): Measurement => estimateContributions(contributions, { ...options, purpose: "analysis" })

/**
 * The shared estimator for execution budgeting and client analysis. Native
 * PDFs use a configured allowance and retain an explicit unmeasured
 * provider-page-expansion component, so their coverage is partial rather
 * than an exact provider count. Unknown contributions never become zero.
 */
export const estimateContributions = (
  contributions: ReadonlyArray<EstimatorContribution>,
  options: EstimatorOptions = {},
): Measurement => {
  const imageTokens = options.imageTokens ?? ESTIMATOR_IMAGE_TOKENS
  const pdfTokens = options.pdfTokens ?? ESTIMATOR_PDF_TOKENS
  const measured: Array<ContributionMeasurement> = []
  const unavailable: Array<{ contributionPosition: number; reason: string }> = []
  for (const contribution of contributions) {
    const representationIds = [...(contribution.representationIds ?? [])]
    if (contribution.kind === "unavailable") {
      measured.push({
        contributionPosition: contribution.position,
        basis: "unavailable",
        methodVersion: ESTIMATOR_METHOD_VERSION,
        tokens: null,
        representationIds,
        unavailableReason: contribution.reason,
      })
      unavailable.push({ contributionPosition: contribution.position, reason: contribution.reason })
      continue
    }
    if (contribution.kind === "image") {
      measured.push({
        contributionPosition: contribution.position,
        basis: "configured-image-allowance",
        methodVersion: ESTIMATOR_METHOD_VERSION,
        tokens: imageTokens * (contribution.count ?? 1),
        representationIds,
      })
      continue
    }
    if (contribution.kind === "native-pdf") {
      measured.push({
        contributionPosition: contribution.position,
        basis: "configured-pdf-allowance",
        methodVersion: ESTIMATOR_METHOD_VERSION,
        tokens: pdfTokens * (contribution.count ?? 1),
        representationIds,
      })
      const reason = "provider page expansion is not measured"
      measured.push({
        contributionPosition: contribution.position,
        basis: "unavailable",
        methodVersion: ESTIMATOR_METHOD_VERSION,
        tokens: null,
        representationIds,
        unavailableReason: reason,
      })
      unavailable.push({ contributionPosition: contribution.position, reason })
      continue
    }
    measured.push({
      contributionPosition: contribution.position,
      basis: "ashe-agent-text-v1",
      methodVersion: ESTIMATOR_METHOD_VERSION,
      tokens: contribution.kind === "text" ? estimateText(contribution.text) : estimateStructured(contribution.value),
      representationIds,
    })
  }
  const knownSubtotal = measured.reduce((sum, contribution) => sum + (contribution.tokens ?? 0), 0)
  return {
    method: "ashe-agent-estimator",
    methodVersion: ESTIMATOR_METHOD_VERSION,
    purpose: options.purpose ?? "execution",
    coverage: unavailable.length === 0 ? "complete" : "partial",
    knownSubtotal,
    contributions: measured,
    unavailable,
  }
}
