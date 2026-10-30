import { Schema } from "effect"
import { builtinTool, type Tool } from "../agent/tools.ts"
import { discoverSkills } from "./skills.ts"

const Args = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of a skill from the Skills section." }),
})

/**
 * `skill`: returns a discovered skill's `SKILL.md` body and directory,
 * decided under the `skill` permission by the skill's name. A skill's
 * `allowed-tools` grants nothing.
 */
export const skillTool = (roots: ReadonlyArray<string>): Tool =>
  builtinTool({
    name: "skill",
    description:
      "Loads a skill's instructions by name. Use it when a task matches a skill in the Skills section; files the instructions mention are relative to the skill's directory.",
    args: Args,
    prepare: (args) => ({ check: { permission: "skill", subjects: [args.name], patterns: [args.name] }, plan: undefined }),
    run: async (args) => {
      const skill = discoverSkills(roots).find((candidate) => candidate.name === args.name)
      if (skill === undefined) return { outcome: "failed", content: `There is no skill named ${args.name}.` }
      return { outcome: "success", content: `Skill directory: ${skill.dir}\n\n${skill.body}` }
    },
  })
