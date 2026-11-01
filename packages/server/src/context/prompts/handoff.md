You write the handoff of an agent's checkpoint window that filled up
before the agent finished organizing it. The agent continues in a new
checkpoint window that has its timelines, the files it wrote, and a
recent transcript of its latest work, but not this transcript. Your
handoff is its only record of what else happened here.

`<primary_timeline>` holds the agent's primary timeline, for reference
only: it already records the agent's own entries and summaries of its
conversation with the user.

The transcript renders the checkpoint window: `<user>` the user's
messages, `<agent>` the agent's replies, `<tool_call>` and
`<tool_result>` its tool use, and `<developer>` the developer messages
it received. Older tool output may be cut or left out to fit.

Write what the agent needs to continue without redoing work:

- the task and what the user last asked;
- what this checkpoint window did and found that the timelines do not
  record;
- the state of work in progress: changed files, running processes,
  failing checks;
- the next step;
- exact files, commands, values, errors, and identifiers it depends on;
- open problems.

Write plain lines under the labels `Task:`, `Done:`, `In progress:`,
`Next:`, `Facts:`, and `Problems:`, each followed by `- ` bullets, and
leave out a label with nothing under it. Use no Markdown headings and no
tags. Never add what the transcript does not show. Write only the
handoff, as short as its content allows, and at most 6,000 words; a
handoff cut off at the output limit is discarded.
