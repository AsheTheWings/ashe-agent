# test262

Runs upstream [test262](https://github.com/tc39/test262) files verbatim through
`test/test262.integration.test.ts`. The files are not committed: `bun run test:test262`, from the repository
root, fetches tc39/test262 at the revision `manifest.json` pins into a directory of its own run, checks out and
verifies that commit, copies the manifest's selection into a second run-owned directory with
`script/sync-test262.ts`, runs the suite over it, and removes both. It needs network access and stays out of the
fast gate; CI runs it. Licensed under `test/LICENSE.test262`.

## Layout

- `manifest.json` — the pinned upstream revision, which upstream directories are copied (every `built-ins` and
  `language` directory, about 14,900 files after filtering), and what is left out.
- `skipped.txt` — vendored files that fail on a known interpreter gap, one `path  # reason` per line. They are
  skipped, and each gap is listed as unchecked in `interpreter-support.md`.
- `run.ts` — runs one file of the corpus that the `ASHE_AGENT_TEST262_DIR` build-time constant names, mirroring
  upstream `test/`: prepends `"use strict"`, provides the harness (`assert`, `Test262Error`,
  `compareArray`, `$DONE`, `$DONOTEVALUATE`) as host globals, and interprets the file's frontmatter (`negative`,
  `flags: [async]`).

## What is not copied

`script/sync-test262.ts` skips a file when its frontmatter declares a `flags`, `features`, or `includes` value the
manifest marks unsupported, or when its code matches one of the manifest's `boundaries` patterns. The sync checks the
checkout is at the pinned revision, so every machine runs the same files. Boundaries are
intentional limits of the interpreter, not compatibility work: classes, prototype objects, property descriptors,
accessors, boxed primitives, typed arrays and buffers, `WeakRef` and `FinalizationRegistry`, `Reflect` and `Proxy`, sloppy mode, `eval`,
`Symbol()`, and the `$262` host API. If one
of those decisions changes, delete its entry and re-sync; the tests are upstream, not lost.

## Commands

```sh
bun run test:test262                                                # fetch, verify, sync, and run the suite
bun run script/sync-test262.ts /path/to/test262 /path/to/corpus     # copy the selection from a checkout at the pinned revision
bun --define 'ASHE_AGENT_TEST262_DIR="/path/to/corpus"' script/test262-report.ts [--write] [prefix]
                                                                    # run everything, group failures by cause; --write regenerates skipped.txt
```

When a fix makes skipped files pass, the report lists them so they can be removed from `skipped.txt`, and the
matching gap in `interpreter-support.md` is checked in the same change.
