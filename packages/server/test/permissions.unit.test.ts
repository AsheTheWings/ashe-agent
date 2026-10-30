import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Permission } from "../src/inputs/shapes.ts"
import { resolvePath, type PathLookup } from "../src/permissions/paths.ts"
import { compileRules, decide, evaluate, wildcard } from "../src/permissions/rules.ts"

const home = "/home/owner"

describe("permission matching", () => {
  test("`*` matches any characters, `?` one, and everything else is literal", () => {
    expect(wildcard("git *", "git status --short")).toBe(true)
    expect(wildcard("git *", "git")).toBe(false)
    expect(wildcard("*", "")).toBe(true)
    expect(wildcard("a?c", "abc")).toBe(true)
    expect(wildcard("a?c", "ac")).toBe(false)
    expect(wildcard("*.env", "/p/.env")).toBe(true)
    expect(wildcard("(a).[b]+$", "(a).[b]+$")).toBe(true)
    expect(wildcard("a.c", "abc")).toBe(false)
    expect(wildcard("rm *", "rm -rf /\nls")).toBe(true)
  })

  test("`~` and `$HOME` at a pattern's start expand to the home directory", () => {
    const rules = compileRules({ read: { "~/secrets/*": "deny", "$HOME": "ask", "a~/*": "deny" } }, home)
    expect(rules.map((rule) => rule.pattern)).toEqual(["/home/owner/secrets/*", "/home/owner", "a~/*"])
    expect(evaluate(rules, "read", "/home/owner/secrets/key")).toBe("deny")
    expect(evaluate(rules, "read", "/home/owner")).toBe("ask")
    expect(compileRules({ read: { "~user/*": "deny" } }, home)[0]!.pattern).toBe("~user/*")
  })

  test("the last matching rule decides, and a call no rule matches is allowed", () => {
    const rules = compileRules({ "*": "ask", shell: { "*": "deny", "git *": "allow" } }, home)
    expect(evaluate(rules, "shell", "git log")).toBe("allow")
    expect(evaluate(rules, "shell", "rm x")).toBe("deny")
    expect(evaluate(rules, "read", "/x")).toBe("ask")
    expect(evaluate(compileRules({}, home), "shell", "rm x")).toBe("allow")
    expect(evaluate(compileRules({ shell: { "git *": "deny" } }, home), "shell", "ls")).toBe("allow")
    expect(evaluate(compileRules("deny", home), "anything", "x")).toBe("deny")
  })

  test("malformed permission values are refused", () => {
    const decode = Schema.decodeUnknownExit(Permission)
    for (const value of ["allowed", 1, null, ["allow"], { shell: "maybe" }, { shell: { "*": "yes" } }, { shell: { "*": { x: "allow" } } }]) {
      expect(decode(value)._tag).toBe("Failure")
    }
    for (const value of ["ask", {}, { shell: "deny" }, { shell: { "git *": "allow" } }]) expect(decode(value)._tag).toBe("Success")
  })
})

describe("layered and multi-subject decisions", () => {
  test("session grants come after agent rules, which come after global rules", () => {
    const global = compileRules({ edit: { "*": "deny" } }, home)
    const agent = compileRules({ edit: { "/p/*": "ask" } }, home)
    const grants = [{ permission: "edit", pattern: "/p/a", action: "allow" as const }]
    expect(evaluate([...global, ...agent, ...grants], "edit", "/p/a")).toBe("allow")
    expect(evaluate([...global, ...agent, ...grants], "edit", "/p/b")).toBe("ask")
    expect(evaluate([...global, ...agent, ...grants], "edit", "/q")).toBe("deny")
    expect(evaluate([...agent, ...global], "edit", "/p/b")).toBe("deny")
  })

  test("given paths are normalized against the working directory, following links before `..`", () => {
    // An in-memory filesystem: `/w`, `/w/b`, `/o`, `/o/t`, a link `/w/l` to `/o/t`, and a dangling link `/w/d` to `../n`.
    const lookup: PathLookup = (path) => {
      if (path === "/w/l") return { kind: "real", path: "/o/t" }
      if (path === "/w/d") return { kind: "dangling", target: "../n" }
      return ["/w", "/w/b", "/o", "/o/t"].includes(path) ? { kind: "real", path } : { kind: "absent" }
    }
    expect(resolvePath("a/../b/./c", "/w", lookup)).toBe("/w/b/c")
    expect(resolvePath("/w//b/", "/x", lookup)).toBe("/w/b")
    expect(resolvePath("..", "/w/b", lookup)).toBe("/w")
    expect(resolvePath("l/../a", "/w", lookup)).toBe("/o/a")
    expect(resolvePath("new/../l/x", "/w", lookup)).toBe("/o/t/x")
    expect(resolvePath("d/x", "/w", lookup)).toBe("/n/x")
  })

  test("any denied subject refuses the call, else asked subjects raise one request, else it runs", () => {
    const rules = compileRules({ read: { "*.env": "deny", "/p/private/*": "ask" }, web: { "https://ask.test/*": "ask" } }, home)
    expect(decide(rules, { permission: "read", subjects: ["/p/a", "/p/b"] })).toEqual({ action: "allow" })
    expect(decide(rules, { permission: "read", subjects: ["/p/a", "/p/private/x", "/p/private/y"] })).toEqual({
      action: "ask",
      asked: ["/p/private/x", "/p/private/y"],
    })
    expect(decide(rules, { permission: "read", subjects: ["/p/private/x", "/p/.env", "/p/a"] })).toEqual({ action: "deny", denied: ["/p/.env"] })
    expect(decide(rules, { permission: "web", subjects: ["https://ok.test/", "https://ask.test/a"] })).toEqual({
      action: "ask",
      asked: ["https://ask.test/a"],
    })
    expect(decide(compileRules({ execute: "ask" }, home), { permission: "execute", subjects: [] })).toEqual({ action: "ask", asked: ["*"] })
  })
})
