import type { Permission } from "../inputs/shapes.ts"

export type Action = "allow" | "ask" | "deny"

/** One rule: calls under a permission name whose subject matches a pattern get an action. */
export interface Rule {
  readonly permission: string
  readonly pattern: string
  readonly action: Action
}

/** What a tool call asks permission for: subjects under one name, and the patterns an `always` grants. */
export interface PermissionCheck {
  readonly permission: string
  readonly subjects: ReadonlyArray<string>
  readonly patterns: ReadonlyArray<string>
}

/** `~` or `$HOME` at a pattern's start, followed by its end or a slash, becomes the home directory. */
export const expandHome = (pattern: string, home: string) =>
  pattern.replace(/^(~|\$HOME)(?=\/|$)/, home)

/** The rules of a `permission` value in opencode's shape, in the order it lists them. */
export const compileRules = (permission: Permission, home: string): ReadonlyArray<Rule> => {
  if (typeof permission === "string") return [{ permission: "*", pattern: "*", action: permission }]
  return Object.entries(permission).flatMap(([name, value]) =>
    typeof value === "string"
      ? [{ permission: name, pattern: "*", action: value }]
      : Object.entries(value).map(([pattern, action]) => ({ permission: name, pattern: expandHome(pattern, home), action })),
  )
}

const escapeRegExp = (text: string) => text.replace(/[.+^${}()|[\]\\/]/g, "\\$&")

/** Whether `value` matches `pattern`, where `*` matches any characters, `?` one character, and the rest is literal. */
export const wildcard = (pattern: string, value: string): boolean => {
  const source = [...pattern].map((char) => (char === "*" ? "[\\s\\S]*" : char === "?" ? "[\\s\\S]" : escapeRegExp(char))).join("")
  return new RegExp(`^${source}$`).test(value)
}

/** The action the last rule matching the name and subject gives, or `allow` when none matches. */
export const evaluate = (rules: ReadonlyArray<Rule>, permission: string, subject: string): Action => {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!
    if (wildcard(rule.permission, permission) && wildcard(rule.pattern, subject)) return rule.action
  }
  return "allow"
}

export type Decision =
  | { readonly action: "allow" }
  | { readonly action: "deny"; readonly denied: ReadonlyArray<string> }
  | { readonly action: "ask"; readonly asked: ReadonlyArray<string> }

/**
 * Decides a call per subject, then as a whole: any denied subject refuses
 * the call, else any asked subject raises one request naming them, else it
 * runs. A call with no subject is decided for `*`.
 */
export const decide = (rules: ReadonlyArray<Rule>, check: Omit<PermissionCheck, "patterns">): Decision => {
  const subjects = check.subjects.length === 0 ? ["*"] : check.subjects
  const actions = subjects.map((subject) => ({ subject, action: evaluate(rules, check.permission, subject) }))
  const denied = actions.filter((entry) => entry.action === "deny").map((entry) => entry.subject)
  if (denied.length > 0) return { action: "deny", denied }
  const asked = actions.filter((entry) => entry.action === "ask").map((entry) => entry.subject)
  if (asked.length > 0) return { action: "ask", asked }
  return { action: "allow" }
}

/** A call the rules deny; the model is told so, and the call never runs. */
export class PermissionDenied extends Error {
  constructor(readonly subjects: ReadonlyArray<string>) {
    super("denied by configuration")
  }
}

/** A call the owner rejected: without a message the turn ends, with one the model gets it and goes on. */
export class PermissionRejected extends Error {
  constructor(readonly reason: string | undefined) {
    super(reason ?? "rejected")
  }
}
