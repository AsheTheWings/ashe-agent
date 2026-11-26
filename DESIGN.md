---
version: alpha
name: AsheAgent Web Client
description: Compact, accessible agent workspace with a two-bar session header, multi-theme palette library, and three synchronized views.
typography:
  brand-mark:
    fontFamily: Asimovian
    fontWeight: 400
  body:
    fontFamily: Geist Variable
    fontSize: 0.875rem
  input-minimum:
    fontSize: 0.8125rem
spacing:
  sidebar-width: 264px
  header-primary: 44px
  header-preview: 36px
  sidebar-breakpoint: 48rem
  scrollbar-compact: 0.25rem
rounded:
  favicon: 6px
  control: 6px
  card: 12px
  composer: 14px
  pill: 9999px
omitted:
  - section: colors
    reason: Exact stock tokens and the built-in multi-theme library are specified in Colors prose and packages/web/src/app/theme/palettes.ts.
  - section: components
    reason: Primitives come from shadcn/ui (Base UI, base-nova style) and AI Elements patterns documented in Components prose.
---

# AsheAgent Web Client Design System

## Overview

AsheAgent's built-in web client is an all-day agent workspace for running,
steering, and inspecting durable sessions. It favors compact, scannable
density, clear separation between conversation and inspection views, and
native `shadcn/ui` (`@base-ui/react`) primitives over hand-rolled HTML controls.

## Colors

### Stock Palette & Multi-Theme Architecture

The default stock palette (`System stock`) uses warm, low-glare surfaces
instead of stark pure white or pure black:

- **Light (`color-scheme: light`):** Paper background (`#f8f7f3`), warm
  sidebar (`#efeee8`), raised cards (`#fffefa`), secondary surface (`#efede6`),
  accent hover (`#eae6dc`), hairline borders (`#e1ddd3`), input borders
  (`#cfc9bc`), deep warm ink (`#292721`), muted ink (`#69665d`), terracotta
  accent (`#9c462e`, foreground `#fff9f5`, ring `#ad543b`, tint `#f2e4da`),
  and semantic status tokens (`--destructive`, `--destructive-foreground`,
  `--positive`, `--positive-background`, `--warning`, `--warning-background`,
  `--scrollbar-border`).
- **Dark (`color-scheme: dark`):** Charcoal background (`#211f1b`), sidebar
  (`#282622`), raised cards (`#2a2823`), secondary (`#35312a`), accent
  (`#403a31`), borders (`#423c33`), input borders (`#5a5144`), parchment text
  (`#eeeae2`), muted text (`#b9b1a3`), and lifted terracotta accent (`#e5a186`,
  foreground `#2c2019`, tint `#49342c`).

On top of the stock palette, AsheAgent provides a browser-stored theme library
(`Claude`, `T3 Chat`, `Grove`, `Ocean`, `Ember`, `Iris`, custom themes,
light/dark mix, and live preview editor) inside **Settings → Appearance**. Named
themes paint the same semantic CSS variables atomically (`.no-transitions`).
Never hardcode palette-specific Tailwind classes (`bg-red-50`, `text-red-900`,
`bg-black/20`) in workspace components.

Never rely on color alone for session or execution status: pair semantic color
with explicit labels or icons (`Working`, `Needs you`, `Filed`, `Unread`).

## Typography

- **UI & prose:** `Geist Variable` self-hosted via `@fontsource-variable/geist`.
- **Brand mark:** `Asimovian` self-hosted via `@fontsource/asimovian` for the
  standalone `AA` monogram across the sidebar header, empty workspace, and
  sign-in card; `"AsheAgent"` appears as the browser document `<title>`.
- **Inputs & textareas:** At least `0.8125rem` (`13px`) including placeholders.
- **Counters & metadata:** Use `tabular-nums` or monospace for token counts,
  byte lengths, timestamps, and identifiers so changing counts never shift
  adjacent controls.

## Layout

### Workspace Shell: Sidebar, Primary Window & Secondary Window

- **Desktop (`>= 48rem`):** A resizable conversation sidebar (`264px` default,
  clamped `220px`–`420px`, persisted in browser storage, `var(--sidebar)`, right
  border with a `12px` drag-resize hit strip and `2px` hover/drag highlight)
  toggles via the landscape left-rail pane icon between **docked** (shifts the
  workspace) and **floating** (overlays on left-edge or toggle hover). The
  sidebar separates sessions into **Working**, **Inbox**, and a collapsible
  **Filed** section (also a drag-and-drop filing target) above a sticky bottom
  tray holding **Settings** and **Sign out**.
- **Primary & Secondary Windows:** To the right of the sidebar, the workspace
  splits into a **Primary Window** (hosting the active session header, view, and
  composer) and an optional right-hand **Secondary Window** (`36%` default,
  clamped `24%`–`60%`, persisted in browser storage, separated by the same
  vertical drag-resize handle). The mirrored right-rail toggle icon (`Ctrl+.`)
  appears only when the active view provides secondary content (currently
  Session insights and Checkpoint window context breakdown + snapshot switcher);
  clicking the Session or Checkpoint `ViewPanel` toggles the Secondary Window.
  When open on desktop, the toggle button moves into the Secondary Window's
  `44px` header while the Primary Window header keeps a fixed `40px` slot
  reserved so adjacent controls never shift horizontally.
- **Mobile (`< 48rem`):** The sidebar opens as a left `Sheet` drawer and the
  Secondary Window opens as a right `Sheet` drawer so the primary view uses the
  full viewport width.

### Primary Workspace Header, `ViewPanel` & `SessionNotifications` Bar

Every active session keeps a `44px` primary header bar on desktop (`>= 48rem`)
hosting the sidebar toggle (when floating or on mobile), the session title, a
centered inset **`ViewPanel`** slot owned by the active view, the **View**
selector dropdown (`Chat`, `Session`, `Checkpoint window` with keyboard hint),
and the reserved Secondary Window toggle slot. On narrow mobile viewports
(`< 48rem`), `ViewPanel` drops to a compact `36px` strip below the primary bar.

- **`SessionNotifications` secondary bar:** Whenever actionable alerts, errors,
  or user-action items exist across sessions (including connection/app errors,
  resumable turns, pending permissions/questions, execution failures, and
  recoverable/unsupported drafts), `SessionNotifications` renders as a `36px`
  secondary bar directly below the primary bar showing the latest entry;
  clicking it expands a 5-row scrollable list (`max-h-[185px]`) with per-entry
  actions. App errors always appear in this bar and never overlay the page.
  When no notifications are active, the bar is omitted.
- **Token formatting & tooltips:** Token counts render as compact unitless
  numbers below `1,000` (`754`, `~120`) and `K`/`M` at or above `1,000` (`4.7K`,
  `79.1K`, `1.2M`), paired with first-class themed `Tooltip` overlays
  (`bg-popover`, `text-popover-foreground`, subtle hairline border, no arrow)
  giving exact counts and descriptions across the workspace.
- **`ViewPanel` by view:**
  - **Chat:** `ActivityPreview` (latest thought summary and latest tool call
    with status, persistent when idle).
  - **Session:** Compact session insights (total/user/agent messages, tool call
    count and most-used tool, compact estimated token count); clicking toggles
    the **Session insights** Secondary Window.
  - **Checkpoint window:** Input-only compact token count, a stacked horizontal
    distribution bar grouped into **Harness** (System message, Tool
    definitions, Developer messages, Tool results), **Agent output**, and **User
    messages**, and the snapshot label `Window <N> · <time>` (plus a `Latest`
    reset control when viewing a historical snapshot); clicking toggles the
    **Checkpoint window** Secondary Window showing **Context breakdown** (`est.
    · 1T ≈ 4 chars`), the stacked horizontal bar and 3-group breakdown, and the
    timestamped snapshot switcher.

### Inspection Views, Timestamps & Cross-View Navigation

Session and Checkpoint window render full-width, horizontally padded blocks
(`SYSTEM-MESSAGE`, `DEVELOPER-MESSAGE`, `USER-MESSAGE`, `AGENT-MESSAGE` with
the `AA` brand monogram icon, `AGENT-THOUGHT`, `AGENT-TOOL`) separated by
horizontal hairline dividers (`divide-y`) without card backgrounds. Every block
groups its header details together inline on the left (icon, kind label,
tool/component metadata, author/model identity where applicable, and compact
token estimate with exact tooltips) for single-glance lookup. Session blocks include a human-readable full
date and time in the header; Checkpoint window blocks omit per-block timestamps
(snapshot timing lives in the Checkpoint window header). Chat messages reveal
friendly relative timestamps (`Just now`, `5 mins ago`, `2 hours ago`,
`Yesterday`) on hover/focus alongside message actions, with full date/time on
tooltip. Switching from Chat to Session anchors Session's scroll position
instantly to the focused user message in Chat without moving Chat's saved scroll
position on return. Selection-safe `Shift+click` on an agent message in Chat or
an agent message, thought, or tool block in Session jumps directly to the
Checkpoint window snapshot that generated it. In Checkpoint window,
`TOOL-DEFINITIONS` is always the first block and the only collapsible block
(collapsed by default via `Collapsible`); every other block stays expanded,
maximizing scannable width for traces, developer components (including
foreign-owner transcripts), diffs, and cleared tool results while omitting
empty text-less agent carrier entries. `DEVELOPER-MESSAGE`, `SYSTEM-MESSAGE`, and human `USER-MESSAGE`
headers omit agent/model identity; peer-agent `USER-MESSAGE` headers display
the sending agent's identity and session link. `AGENT-TOOL` merges kind, tool
name, colored outcome badge (`success`, `failed`, `running`), and
right-aligned agent identity onto one header row above equal-height (`208px`
baseline, expanding up to `288px` when content nearly fits to avoid tiny
scrollbars) scrollable Input and Result panes with formatted, theme-tokenized
JSON. Large page-omitted bodies hydrate automatically as they enter the
viewport. Chat keeps a centered prose column (`max-w-3xl`) with right-aligned
user bubbles and no inline thought blocks.

### Settings Dialog

All workspace configuration lives in one extensible **Settings** dialog opened
from the sidebar footer:

- **Appearance:** Light/Dark/System mode, built-in and custom theme library,
  light/dark half-mixing, import/export, and the live custom theme editor.
- **Shortcuts & Input:** View-cycle shortcut (`Ctrl+I` / `Alt+I`) and
  type-to-compose behavior.
- **Session:** Active session metadata (copyable session ID, workspace path,
  applied profile/model) and title-scoped permission grants with `AlertDialog`
  confirmation before clearing.

### Scrollbars

Drive scrollbar tint from `--scrollbar-border` (`30 3.3% 11.8%` light;
`51 16.5% 84.5%` dark) using standard `scrollbar-width: thin` on both
`.scrollbar-main` (with `scrollbar-gutter: stable`, extending beneath the
overlaid two-bar workspace header) and `.scrollbar-compact` (inner scroll
regions such as the sidebar list, notifications drawer, edit box, and
multiline composer).

## Elevation & Depth

Use subtle borders and surface contrast (`background` vs. `sidebar` vs. `card`
vs. `muted`) rather than heavy drop shadows. Reserve shadows for floating
overlays (`Dialog`, `AlertDialog`, `DropdownMenu`, `Select`, `Popover`,
`Sheet`, `Toaster`).

## Shapes

- `6px`: browser tab favicon box (`32×32` viewBox), compact buttons, inputs,
  and navigation rows.
- `12px`: dialogs, alerts, tool cards, reasoning blocks, and metric cards.
- `14px`: unified composer card.
- `9999px`: status pills, attachment chips, and compact scrollbar thumbs.

## Motion & Micro-interaction

Use motion only to clarify state transitions (collapsible panels, live
thinking shimmer, spinner on running tools/sessions). Respect
`prefers-reduced-motion`. Keep scroll position stable across view switches and
incoming updates when the user has scrolled up.

## Voice & Content Strategy

- Use clear, user-facing labels: **Agent** (for agent profile selection),
  **Model**, **Effort**, **File** / **Reopen** (for session filing), **Send**,
  **Stop**, **Continue**.
- Show applied vs. requested selection differences only when the draft differs
  from the applied session state rather than printing raw internal IDs on every
  idle screen.
- Clear transient `"Sent."` feedback automatically and place errors beside the
  failed action with a recovery button where available.

## Components

- **Primitives:** Use `shadcn/ui` (`@base-ui/react`) components in
  `packages/web/src/components/ui/` (`Button`, `Select`, `Tabs`, `Dialog`,
  `AlertDialog`, `Sheet`, `DropdownMenu`, `Collapsible`, `Popover`, `Switch`,
  `Checkbox`, `Input`, `Textarea`, `Table`, `Badge`, `Tooltip`, `Kbd`, `Alert`,
  `Card`, `Separator`) and `lucide-react` icons. Never use `window.confirm()`,
  `window.alert()`, or unstyled `<select>` / `<details>` elements.
- **Conversation & Markdown:** Render assistant text with GFM Markdown
  (`react-markdown` + `remark-gfm`) and user text as whitespace-preserving plain
  text without evaluating raw HTML or SVG; validate link schemes
  (`http:`/`https:`) and keep external images behind explicit consent
  placeholders. Fold long user messages past `300px` with a bottom fade and a
  `Show more` / `Show less` toggle. Reveal secondary user message actions
  (**Rewind**, **Edit**, **Fork**, **Copy**) cleanly on hover/focus; **Edit**
  switches the user bubble into an in-place editor with `Cancel` and `Save`.
  On send, expand elastic bottom space so the sent user bubble pins near the
  top of the viewport while the assistant response streams.
- **Composer:** On `/` (before any session exists; created on first send) and
  on an empty session in Chat, a vertically centered starter card
  (`16px` radius, spacious multi-line input, internal bottom toolbar with `+`
  attach, agent selector, Model + Thinking Effort menu, and primary Send arrow)
  sits beneath the `AA` mark and `"Start a conversation"` heading. Once
  conversation history exists (or on Session and Checkpoint views), a sticky
  bottom overlay card (`14px` radius, hairline ring and
  soft shadow with hover/focus elevation) rests over a 40px eased page fade
  with zero banners above it. It starts as a single `44px` row (`+` attach,
  input, ghost return-arrow Send; while a turn runs, a borderless rounded-square
  Stop occupies the action slot when empty and switches to Send when a
  submission is ready) and transitions into a full-width scrollable
  multi-line editor with a bottom action row when lines wrap or attachments
  are added. Image and document attachments render as `120×120px` cards in a
  horizontally scrollable strip with edge fades and hover remove buttons. A
  quiet footer row below holds the agent title selector, contextual queue
  toggle while running, and a combined Model + Thinking Effort menu that
  configures reasoning effort in a nested `Effort` submenu.
- **Data visualization:** Use a segmented horizontal semantic distribution bar
  (`--chart-1`–`--chart-5`, `--primary`) in the Checkpoint window `ViewPanel`
  and Secondary Window to visualize token distribution across **Harness**,
  **Agent output**, and **User messages**, paired with compact unitless /
  `K` / `M` counters and exact tooltips throughout.

## Do's and Don'ts

- Keep the two-bar header clean and constant; put configuration in Settings.
- Use `AlertDialog` for destructive confirmations (clearing permission grants,
  deleting custom themes) and a dedicated confirmation `Dialog` with a
  destructive impact warning for rewinding turns.
- Preserve all security and recovery invariants: no untrusted HTML/SVG
  execution, consent-gated external images, local draft durability, and
  explicit multi-tab draft recovery.
