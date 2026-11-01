import {
  NOTE_MAX_LENGTH,
  OPTION_DESCRIPTION_MAX_LENGTH,
  OPTION_LABEL_MAX_LENGTH,
  QUESTION_HEADER_MAX_LENGTH,
  QUESTION_MAX_LENGTH,
  QUESTION_OPTIONS_MAX,
  QUESTION_OPTIONS_MIN,
  QUESTIONS_MAX,
} from "./constants.ts"
import { codePoints, type NewEntry } from "./entries.ts"
import type { AskArgs } from "./tools.ts"

/** One answer of a `session.answerQuestion` request: an option's label, a note, or both; neither skips the question. */
export interface Answer {
  readonly id: string
  readonly selection?: string
  readonly note?: string
}

/**
 * The shape problems of a `context_ask_question` call: 1 to 3 questions
 * with unique non-empty ids, each with a header, question, and 2 or 3
 * options within their lengths, and feedback within a note's length.
 */
export const questionProblems = (args: AskArgs): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const span = (what: string, text: string, min: number, max: number) => {
    const length = codePoints(text)
    if (length < min || length > max) problems.push(`${what} holds ${length} characters, not ${min} to ${max}`)
  }
  if (args.feedback !== undefined) span("feedback", args.feedback, 1, NOTE_MAX_LENGTH)
  if (args.questions.length < 1 || args.questions.length > QUESTIONS_MAX) problems.push(`a call asks 1 to ${QUESTIONS_MAX} questions, not ${args.questions.length}`)
  const ids = new Set<string>()
  for (const [index, question] of args.questions.entries()) {
    const at = `question ${index + 1}`
    if (question.id === "") problems.push(`${at} has an empty id`)
    if (ids.has(question.id)) problems.push(`${at} repeats the id ${question.id}`)
    ids.add(question.id)
    span(`${at}'s header`, question.header, 1, QUESTION_HEADER_MAX_LENGTH)
    span(`${at}'s question`, question.question, 1, QUESTION_MAX_LENGTH)
    if (question.options.length < QUESTION_OPTIONS_MIN || question.options.length > QUESTION_OPTIONS_MAX) {
      problems.push(`${at} has ${question.options.length} options, not ${QUESTION_OPTIONS_MIN} to ${QUESTION_OPTIONS_MAX}`)
    }
    for (const [option, choice] of question.options.entries()) {
      span(`${at}'s option ${option + 1} label`, choice.label, 1, OPTION_LABEL_MAX_LENGTH)
      span(`${at}'s option ${option + 1} description`, choice.description, 1, OPTION_DESCRIPTION_MAX_LENGTH)
    }
  }
  return problems
}

/**
 * The answer entries of `answers` to `questions`, in the order of the
 * answers, and the ids of the questions skipped; or the problem refusing
 * the answers: an unknown or repeated question, an unknown option, or a
 * note outside 1 to 2,000 characters.
 */
export const answerEntries = (
  questions: AskArgs["questions"],
  answers: ReadonlyArray<Answer>,
): { readonly ok: true; readonly entries: ReadonlyArray<NewEntry>; readonly skipped: ReadonlyArray<string> } | { readonly ok: false; readonly problem: string } => {
  const byId = new Map(questions.map((question) => [question.id, question]))
  const seen = new Set<string>()
  const answered = new Set<string>()
  const entries: Array<NewEntry> = []
  for (const answer of answers) {
    const question = byId.get(answer.id)
    if (question === undefined) return { ok: false, problem: `no question ${answer.id} in this set` }
    if (seen.has(answer.id)) return { ok: false, problem: `question ${answer.id} is answered twice` }
    seen.add(answer.id)
    const option = answer.selection === undefined ? undefined : question.options.find((candidate) => candidate.label === answer.selection)
    if (answer.selection !== undefined && option === undefined) return { ok: false, problem: `question ${answer.id} has no option ${answer.selection}` }
    if (answer.note !== undefined && (codePoints(answer.note) < 1 || codePoints(answer.note) > NOTE_MAX_LENGTH)) {
      return { ok: false, problem: `the note to question ${answer.id} holds ${codePoints(answer.note)} characters, not 1 to ${NOTE_MAX_LENGTH}` }
    }
    if (option === undefined && answer.note === undefined) continue
    answered.add(answer.id)
    entries.push({
      kind: "answer",
      fields: {
        Question: question.question,
        ...(option === undefined ? {} : { Selection: `${option.label}: ${option.description}` }),
        ...(answer.note === undefined ? {} : { UserNote: answer.note }),
      },
    })
  }
  return { ok: true, entries, skipped: questions.filter((question) => !answered.has(question.id)).map((question) => question.id) }
}
