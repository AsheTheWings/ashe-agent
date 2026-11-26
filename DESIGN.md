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

### Workspace Shell

- **Desktop (`>= 48rem`):** A `264px` conversation sidebar (`var(--sidebar)`,
  right border) that toggles between **docked** (shifts the main workspace) and
  **floating** (overlays the main workspace on left-edge or toggle hover without
  shifting layout), persisted in browser storage. The sidebar separates sessions
  into **Working**, **Inbox**, and a collapsible **Filed** section (which also
  serves as a drag-and-drop filing target when dragging a session row). A sticky
  bottom tray holds **Settings** and **Sign out**.
- **Mobile (`< 48rem`):** The sidebar opens as a `Sheet` drawer so the
  conversation and two-bar header use the full viewport width.

### Constant Two-Bar Workspace Header

Every active session keeps a constant two-bar header so the layout never jumps
as agent runs start or finish:

1. **Primary bar (`44px`):** Sidebar dock/float toggle (when floating or on
   mobile) and the session title on the left; the **View** selector dropdown
   (`Chat`, `Session`, `Checkpoint window` with keyboard hint) on the right.
2. **`SessionNotifications` / contextual overview bar (`36px`):** Edge-to-edge
   full-height bar:
   - **Chat:** `SessionNotifications` queue showing the latest single entry
     when collapsed and expanding to a five-entry scrollable viewport (latest
     at top) on click. `ActivityPreview` (latest thought summary and latest
     tool call with status, persistent when idle) lives as an entry in the
     queue alongside resumable turns, waiting inputs, execution notices, draft
     recovery, and composer status—keeping the area above the composer free of
     alerts.
   - **Session:** Compact session insights (total/user/agent messages, tool call
     count and most-used tool, estimated tokens) with a breakdown popover and a
     queue toggle when alerts are waiting.
   - **Checkpoint window:** Estimated context tokens, coverage, separate
     provider-reported usage, and a segmented semantic distribution bar
     (including individual developer components) with a `@tanstack/charts`
     breakdown popover and a queue toggle when alerts are waiting.

### Inspection Views (Session & Checkpoint)

Session and Checkpoint window render full-width, horizontally padded,
always-expanded blocks (`SYSTEM-MESSAGE`, `DEVELOPER-MESSAGE`, `USER-MESSAGE`,
`AGENT-MESSAGE`, `AGENT-THOUGHT`, `AGENT-TOOL`) separated by horizontal
hairline dividers (`divide-y`) without card backgrounds or collapse toggles,
maximizing scannable width for traces, developer components, diffs, and
model-input contributions while omitting empty text-less agent carrier entries
from Session. `DEVELOPER-MESSAGE`, `SYSTEM-MESSAGE`, and human `USER-MESSAGE`
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
- **Data visualization:** Use `@tanstack/charts` (`--chart-1`) alongside a
  segmented semantic distribution bar (`--chart-1`–`--chart-5`) in the
  Checkpoint window to visualize token distribution across contributions,
  paired with a structured `Table` for measurements and provider usage.

## Do's and Don'ts

- Keep the two-bar header clean and constant; put configuration in Settings.
- Use `AlertDialog` for destructive confirmations (clearing permission grants,
  deleting custom themes) and a dedicated confirmation `Dialog` with a
  destructive impact warning for rewinding turns.
- Preserve all security and recovery invariants: no untrusted HTML/SVG
  execution, consent-gated external images, local draft durability, and
  explicit multi-tab draft recovery.
