# Tools

The agent's built-in tools are grouped in namespaces. Models receive each
as a plain function tool named `<namespace>_<tool>`, since not every
provider accepts namespaced or dotted tool names.

| Tool | Permission | Subjects |
| --- | --- | --- |
| `file_read` | `read` | each file read, resolved |
| `file_patch` | `edit` | each path the patch writes, reads to update, or removes, resolved |

[Permissions](permissions.md) explains how subjects are resolved and
decided. A tool resolves its paths once, when the call is checked, and
reads, writes, and removes exactly those paths. When a path resolves
differently by the time the call runs, for example because a symlink
changed while the call waited for an answer, `file_read` does not read
that file and `file_patch` changes nothing. A change between that last
check and the read or write itself is not detected.

A path a patch deletes, or moves a file away from, is decided as the
directory entry it names, so deleting a symlink removes the link without
reading its target. A move is also decided for the file its content is
read from and for its destination.

## `file_patch`

`file_patch` takes one `patch` string in Codex's `apply_patch` format:
`*** Begin Patch`, then `*** Add File:`, `*** Delete File:`, and
`*** Update File:` hunks, an update optionally followed by
`*** Move to:`, with `@@` context lines and `*** End of File`, then
`*** End Patch`. Relative paths resolve against the session's starting
working directory.

The whole patch is checked under the `edit` permission before any file
changes, then its hunks are applied in order. Add File replaces an
existing file, and a move replaces an existing destination. A hunk that
fails stops the patch, and the result names the hunks applied before it.
An update's context matches exactly, else ignoring trailing whitespace,
else ignoring surrounding whitespace, else after normalizing Unicode
punctuation and spaces. Unchanged lines keep their line endings, and
inserted lines take the file's first line ending.

The parser and context matching are ported from opencode's patch module,
and the vendored scenarios of Codex's apply-patch crate, under
`packages/server/test/fixtures/codex-apply-patch/`, check that it behaves
as Codex does.

## `file_read`

`file_read` takes a `path`, either one path or a list of paths and glob
patterns, with an optional `offset`, `column`, and `limit`. Relative paths resolve
against the session's starting working directory. Nothing records what a
session read.

Text comes back numbered as `cat -n` numbers it: at most 2,000 lines,
128 KB, and 2,000 characters per line. A negative offset counts from the
end, `-1` being the last line. When a read stops at a ceiling, at an empty
file, or past the end, its result says so and names the offset to
continue from. A line cut at 2,000 characters continues from the offset
and `column`, the line's character to start from, that the result names.
A leading byte order mark is removed and CRLF line endings
become LF.

A list of paths and globs reads each file under a `==> path <==` header,
reports each file's failure inline, and stops at 100 KB of text in total,
naming the files it did not read. One glob reads at most 1,000 files.

`file_read` refuses paths under `/dev` and `/proc/<pid>/fd`, character and
block devices, FIFOs, and sockets before reading them, and binary files
and files over 32 MB.

### Documents

A file of at most 32 MB that anydoc detects as a document, or a `.csv`
file, is converted to Markdown in the server's own process and read
through the same windows as text. Conversion never uses anydoc's hosted
OCR, so no document leaves the host. A failed conversion names anydoc's
error code; a PDF with scanned or image-only pages reports `needsOcr` and
the pages that need OCR.

### Images

A PNG, JPEG, GIF, or WebP file of at most 20 MB is returned as an image
when the turn's model is declared to take images, and as a result saying
the model cannot view images otherwise. Text renderings of the
conversation, such as records of another model's work and compaction
input, show the image as `[image: <path>]`.
