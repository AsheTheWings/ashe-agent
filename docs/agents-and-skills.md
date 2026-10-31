# Agents, instructions, and skills

A session's user instructions, its agent, and the skills its model can
load all come from the server user's configuration, never from the session's
directory: the server reads no `AGENTS.md`, `CLAUDE.md`, or skill
directory there or in its ancestors.

## Agents

An agent is the configuration a session runs as. The `agents` input maps
each agent's title to its entry; the
[config schema](../schemas/config.schema.json) and the generated
[`.env`](../.env) own each input's name, shape, and default. An entry's fields
are optional:

| Field | Meaning |
| --- | --- |
| `model` | The `<provider>/<model>` id the agent's sessions start with, in place of the one a request names. |
| `models` | Overrides of each model's `checkpointWindowSize`, `temperature`, and `reasoningEffort`, keyed by model id. |
| `permission` | Rules in the [permissions](permissions.md) shape, layered after the global rules. |

```json
{
  "agents": {
    "code-reviewer": {
      "model": "main/thinker",
      "models": { "main/thinker": { "reasoningEffort": "high" } },
      "permission": { "edit": "deny", "shell": { "*": "ask", "git diff*": "allow" } }
    }
  },
  "defaultAgent": "code-reviewer"
}
```

A title is 1 to 64 characters of `a-z` and `0-9` words joined by single
dashes, the rule skill names follow. Clients show an agent by its display
title, the title's words capitalized and joined by spaces, such as
`Code Reviewer` for `code-reviewer`.

A session created without an agent runs as `defaultAgent`, which must be
an agent's title. Without a default agent, it runs as the implicit agent,
which has no title, no model or overrides of its own, and only the
global rules. Creating a session records its agent's title, model
overrides, and permission rules; a fork keeps what its source recorded,
and changing an agent's entry takes a server restart and reaches only
sessions created after it.

`agents.list` returns each agent with its display title, its title
file's state and description, its model, and its reasoning effort
overrides, and the default agent.

## Title files and user instructions

An agent's title file is `<title>.md` in the titles directory,
`ASHE_AGENT_TITLES_DIR`. It holds YAML frontmatter with only a
`description` of 1 to 1,024 characters, then a Markdown body that is the
agent's user instructions:

```markdown
---
description: Reviews changes without editing them
---
You review the working tree and report findings.
```

The server reads a title file as a regular file and never through a
symlink. A file that is a symlink, is unreadable, or holds any other
frontmatter key is refused, and `agents.list` reports it as refused with
the reason; a file named for no agent is ignored.

A session's user instructions are its agent's title file body while the
title file exists, in every session of that agent. Otherwise they are
the content of the global instructions file,
`ASHE_AGENT_INSTRUCTIONS_FILE`, and when that file is absent the session
has none. A refused title file or an unreadable global instructions file
fails the session's creation, naming the file and the reason. A session
records its user instructions at creation, as the Instructions section
of its developer message that [model context](model-context.md)
describes.

## Skills

Skills follow the [Agent Skills specification](https://agentskills.io/specification).
When a session is created, and at each turn, the server looks for
`<root>/<name>/SKILL.md` under each skill root,
`ASHE_AGENT_SKILL_ROOTS`, in order. A skill is skipped when its `name` is
not 1 to 64 characters of `a-z`, `0-9`, and single inner `-`, or differs
from its directory's name, or when its `description` is empty or longer
than 1,024 characters. When two roots hold a skill of the same name, the
earlier root's is used.

The developer message's Skills section lists each skill's name,
description, and directory, never its body, leaving out each skill the
session's rules deny under the `skill` permission. The `skill` tool returns a
skill's body and directory by name, decided under the `skill`
permission by that name. A skill's `allowed-tools` field changes no
permission decision.
