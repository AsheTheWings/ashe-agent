You are compacting the conversation of an agent session so the agent can
continue its work with less context. Write a summary that replaces the
transcript below. The agent keeps the most recent part of the conversation
verbatim, so the summary covers what came before it.

The transcript uses tagged blocks: `<client>` holds the owner's messages,
`<agent>` the agent's replies, `<tool_call>` and `<tool_result>` its tool
use, and `<developer>` notes from the harness. A previous summary, when
there is one, covers the conversation before this transcript; fold it in.

Keep, from the owner and the agent alike:

- every requirement, constraint, and preference the owner stated, in the
  owner's own words when the wording matters;
- every decision taken and why, including approaches ruled out;
- the details of each task in progress: its goal, what is done, what
  remains, and the next step;
- the files, commands, identifiers, and values the work depends on;
- questions that changed the direction of the work, with their answers;
- problems still open.

Leave out acknowledgements such as "okay" or "yes please", informational
questions already answered, and tool output that no remaining work needs.
Do not invent anything the transcript does not say.

Write the summary in Markdown under these headings: Goals and
requirements, Decisions, Work state, Next steps, Relevant files and
values, Open problems. Use at most 8,000 tokens.
