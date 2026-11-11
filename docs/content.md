# Content

The server keeps original uploads, bounded model observations, and derived
attachment representations separately. [Storage](storage.md) owns their rows
and files; this page owns the routing and limits between them.

## Attachments

An owner upload is staged in fixed chunks and finalized only when its declared
size and SHA-256 match. The original remains immutable. An input claim binds a
retained attachment identity to a session and input; forks and request
manifests can refer to the same original without copying its bytes.

Before each model call, the turn projects every current attachment for the
selected model's declared capabilities:

- An image reaches an image-capable model as its original image. A model
  without image input receives an explicit unavailable result.
- A PDF reaches a model with native PDF input as a sanitized `input_file`.
  The projection never gives the provider a local path or the original
  filename.
- Otherwise an image-capable model receives ordered PNG page images and
  extractable text from the first configured page window. Page numbers are
  one-based, rendering follows the byte order of the pages, and the result
  says where to continue.
- A text-only model receives extractable PDF text. A PDF with no extractable
  text fails explicitly because OCR is not enabled.

A current attachment that cannot be consumed fails that model call and keeps
the original. Text and document attachments enter the model with the configured
line and byte preview bounds, their total, and a `file_read` continuation
handle. An attachment from an earlier transcript keeps every compatible text,
image, or native PDF representation it already has; only a representation the
selected model cannot consume becomes an explicit placeholder. Derived PDF
text and page images are stored by the original attachment's identity, so a
later projection reuses them before invoking conversion again.

Native PDF parts in retained tool results follow the same capability route
when a later model reads their history: a PDF-capable model receives the
original file, an image-capable model receives rendered pages and text, and a
text-only model receives bounded text. The canonical tool result stays
unchanged; only its model-facing projection changes. A projected PDF window
names its offset, limit, page range, total, and a continuation through the
result's original path or attachment handle. Text and page projections carry
distinct representation identities and renderer metadata. A historical result
image reaches a later image-capable model with its original representation;
an incompatible later model receives an explicit placeholder. User and
historical images cross the Responses boundary as `input_image` content, and
native PDF tool results cross it as `input_file` content.

PDF-derived page images record the renderer and version, page window, one-based
page number, total, width, height, geometry, content digest, and a
representation identity. Each page and page-window transformation gets a
distinct identity even when two rendered pages have the same digest.

## Measurements

The shared `ashe-agent-estimator` estimates text at four characters per token
and canonical JSON for structured input. Images default to 1,500 tokens and
native PDFs to 2,000; the profile can set either allowance. A native PDF's
provider page expansion is recorded as unavailable coverage, so a measurement
that includes one is partial rather than pretending that expansion is zero.

Every request manifest records the measurement used for its budget. Token
measurement is an estimate, not a replacement for product state: a provider's
context error still starts the context turn path. A measurement names its
purpose, execution or analysis, and the command, user, assistant, attachment,
and tool-definition representation identities that contributed. Encrypted
provider replay state whose expansion is opaque is recorded as unavailable
coverage. Provider input, output, and total usage are stored separately on each
model call; they do not replace the estimate.

## Tool output

A tool that captures output may report bytes its producer already omitted and
the full captured text. Output beyond the configured observation preview is
replaced by a bounded head-and-tail window with line and byte totals. When the
result is history-owned, the full captured text is written under the session's
`references/` directory and named by the tool result. The model receives the
reference path and can page it with `file_read`.

A multi-part result with a distinct producer capture retains that capture, not
just the text parts of its model observation. Its text preview comes from the
capture while image and file parts stay in their original order.

A retention failure does not undo the tool's effect or replace its outcome. The
result and turn event record the loss explicitly. `file_read` pages its own
result and is not windowed a second time.

A fork copies the source's retained reference files. A rewind removes reference
rows of removed entries and deletes only files no kept entry owns, so a fork's
copy remains readable after the source is rewound. The final reference's
removal deletes its retained file and removes the empty reference directory.

## PDF conversion

PDF page rendering and text extraction run in a short-lived worker process.
The server starts it through util-linux `prlimit`, which verifies the worker's
`RLIMIT_DATA` before PDFium parses the document. Direct unbounded worker
starts fail closed.

Configuration bounds worker data, stack, CPU, wall time, stdin, stdout, and
stderr. The configured active-worker count defaults to two and the queued-job
count to sixteen. A queued job's input bytes are loaded only after it acquires
an active slot. The worker receives its expected limits as arguments, verifies
them before opening or parsing the stdin request, and carries no limits in that
request. Cancellation, timeout, output overflow, process exit, and completion
kill and reap the worker process group. There is no in-process conversion
fallback: a failed worker fails the current attachment projection explicitly.
`file_read` returns an unmodified PDF natively when the model declares native
PDF input and no page window is requested. It sends explicit page windows, and
PDFs whose declared type is wrong but whose `%PDF-` prefix identifies them, to
the isolated worker when page images or text extraction are needed.

Page geometry bounds DPI, long edge, pixel count, and page-window size. The
worker extracts text and renders PNG pages in page order; it does not perform
OCR. Upload and worker limits are configuration, not extensions of a model's
request.

## Third-party notices

The conversion worker embeds `@hyzyla/pdfium` 3.0.0 and `pngjs` 7.0.0, both MIT,
with a PDFium WebAssembly build under the PDFium license. Exact versions and
notices are in `packages/harness/src/content/NOTICE`, `PDFIUM_LICENSE`,
`PDFIUM_THIRD_PARTY_NOTICES`, and the harness package manifest. The notice
also records lockfile and WebAssembly digests and the lockfile advisory review;
refresh that review with `bun audit` when dependencies change.
