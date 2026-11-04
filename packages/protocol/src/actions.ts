import { Schema } from "effect"
import { Id, PermissionAnswer } from "./shared.ts"
import { Question, QuestionAnswer } from "./events.ts"

/** A server-declared action and the JSON Schemas a client uses to interpret it. */
export const ActionDeclaration = Schema.Struct({
  name: Id,
  description: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
  output: Schema.Record(Schema.String, Schema.Unknown),
})

export type ActionDeclaration = typeof ActionDeclaration.Type

export const QUESTIONS_ACTION = "questions.answer" as const
export const PERMISSION_ACTION = "permission.decide" as const

export const QuestionsActionArgs = Schema.Struct({
  questionSetId: Id,
  feedback: Schema.optionalKey(Schema.String),
  questions: Schema.Array(Question),
})

export type QuestionsActionArgs = typeof QuestionsActionArgs.Type

export const QuestionsActionResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("answered"), answers: Schema.Array(QuestionAnswer) }),
  Schema.Struct({ kind: Schema.Literal("repliedByMessage") }),
])

export type QuestionsActionResult = typeof QuestionsActionResult.Type

export const PermissionActionArgs = Schema.Struct({
  requestId: Id,
  permission: Schema.String,
  subjects: Schema.Array(Schema.String),
  patterns: Schema.Array(Schema.String),
})

export type PermissionActionArgs = typeof PermissionActionArgs.Type

export const PermissionActionResult = Schema.Struct({
  answer: PermissionAnswer,
  message: Schema.optionalKey(Schema.String),
})

export type PermissionActionResult = typeof PermissionActionResult.Type

/** The actions the server registers by default, with the schemas its callers validate against. */
export const builtinActions = {
  [QUESTIONS_ACTION]: {
    description: "Collect one answer set for the question set this execution names.",
    args: QuestionsActionArgs,
    result: QuestionsActionResult,
  },
  [PERMISSION_ACTION]: {
    description: "Collect one permission decision for the request this execution names.",
    args: PermissionActionArgs,
    result: PermissionActionResult,
  },
} as const
