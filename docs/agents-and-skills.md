# Agents, instructions, and skills

A session's instructions, its agent, and the skills its model can load
all come from the server user's configuration, never from the session's
working directory: the server reads no `AGENTS.md`, `CLAUDE.md`, or skill
directory there or in its ancestors.

## Global instructions

A session created without an agent records the content of the global
instructions file, `ASHE_AGENT_INSTRUCTIONS_FILE`, at its creation. When
the file is absent the session has no instructions; when it is present
but unreadable, creating the session fails. The recorded text is the
Instructions section of the session's developer message, as
[model context](model-context.md) describes.

## Agents

Each `<name>.md` file in the agents directory, `ASHE_AGENT_AGENTS_DIR`,
defines the agent `<name>`, in opencode's format: YAML frontmatter, then a
Markdown body that is the agent's instructions.

```markdown
---
description: Reviews changes without editing them
mode: primary
model: provider/model-id
temperature: 0.2
steps: 40
permission:
  edit: deny
  shell: { "*": ask, "git diff*": allow }
---
You review the working tree and report findings.
```

Every field is optional:

| Field | Meaning |
| --- | --- |
| `description` | Shown to clients that list agents. |
| `mode` | `primary`, `subagent`, or `all`, `all` by default. Only `primary` and `all` agents can run a session. |
| `model` | A configured model id the agent's sessions start with. |
| `temperature` | A finite number from 0 to 2, sent with every model call, compaction's summary call included. |
| `steps` | A positive integer bounding a turn's model calls, compaction's summary calls included: the agent's last allowed call goes without tools, after a note asking for a closing reply, and the turn ends; a summary call that takes the last allowed call ends the turn, except that a call that overflowed the context window is still retried once after its summary, as the last call. |
| `permission` | Rules in the [permissions](permissions.md) shape, layered after the global rules. |

A file whose frontmatter breaks these rules is refused, and `agents.list`
returns it with the reason beside the valid agents. Creating a session
with an agent records the agent's body, which replaces the global
instructions, and its `temperature`, `steps`, and `permission`; later
edits to the file do not reach existing sessions, and a fork keeps what
its source recorded.

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
description, and directory, never its body. The `skill` tool returns a
skill's body and directory by name, decided under the `skill`
permission by that name. A skill's `allowed-tools` field changes no
permission decision.
