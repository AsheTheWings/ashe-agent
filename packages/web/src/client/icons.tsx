import type { SVGProps } from "react"

/** Thin crisp plus icon matching Claude's composer attach glyph. */
export const ClaudePlusIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <path d="M10 4.25v11.5M4.25 10h11.5" />
  </svg>
)

/** Crisp return-enter arrow matching Claude's composer send glyph. */
export const ClaudeSendIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <path d="M15.75 5.25v4.5a2 2 0 0 1-2 2H4.75" />
    <path d="M8.25 8.25 4.75 11.75l3.5 3.5" />
  </svg>
)

/** Crisp upward arrow matching Claude's empty-session composer send glyph. */
export const ClaudeArrowUpIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <path d="M10 15.25V4.75" />
    <path d="M5.75 9 10 4.75 14.25 9" />
  </svg>
)

/** Solid rounded square matching Claude's composer stop glyph. */
export const ClaudeStopIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 20 20"
    fill="currentColor"
    aria-hidden="true"
    {...props}
  >
    <rect x="4.5" y="4.5" width="11" height="11" rx="2.75" />
  </svg>
)

/** Two overlapping rounded squares matching Claude's copy glyph (front top-left, back bottom-right). */
export const ClaudeCopyIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <rect x="3.75" y="3.75" width="8.75" height="8.75" rx="2" />
    <path d="M12.75 7.5h1.5a2 2 0 0 1 2 2v4.75a2 2 0 0 1-2 2H9.5a2 2 0 0 1-2-2v-1.5" />
  </svg>
)

/** Left sidebar toggle icon matching Claude's landscape pane with a left rail divider. */
export const SidebarPaneIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <rect x="2.25" y="3.75" width="15.5" height="12.5" rx="2.5" />
    <line x1="7.25" y1="3.75" x2="7.25" y2="16.25" />
  </svg>
)

/** Right secondary window toggle icon mirroring Claude's sidebar pane icon. */
export const SecondaryWindowIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <rect x="2.25" y="3.75" width="15.5" height="12.5" rx="2.5" />
    <line x1="12.75" y1="3.75" x2="12.75" y2="16.25" />
  </svg>
)
