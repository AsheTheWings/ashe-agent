import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { cn } from "cn"

const JSON_HIGHLIGHT_MAX_CHARS = 50_000

/** Baseline height (13rem / `h-52`) for paired tool Input/Result panes. */
export const TOOL_PANE_BASE_HEIGHT = 208
/** Extra vertical slack (~4 lines) allowed so nearly-fitting payloads expand without a tiny scrollbar. */
export const TOOL_PANE_ALMOST_FIT_SLACK = 80

/** Computes a shared height for scrollable payload panes, expanding panes that nearly fit within slack. */
export const resolveScrollPaneHeight = (
  neededHeights: ReadonlyArray<number>,
  baseHeight = TOOL_PANE_BASE_HEIGHT,
  slack = TOOL_PANE_ALMOST_FIT_SLACK,
): number => {
  let target = baseHeight
  for (const needed of neededHeights) {
    if (needed > target && needed <= baseHeight + slack) {
      target = Math.ceil(needed)
    }
  }
  return target
}

const JSON_TOKEN_PATTERN =
  /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|[{}\[\]:,])/g

/** Attempts to format structured values or JSON-encoded strings with 2-space indentation. */
export const formatPayloadText = (value: unknown): { readonly isJson: boolean; readonly text: string } => {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === "object") {
          return { isJson: true, text: JSON.stringify(parsed, null, 2) }
        }
      } catch {
        // Fall back to raw text when not valid JSON.
      }
    }
    return { isJson: false, text: value }
  }
  try {
    return { isJson: true, text: JSON.stringify(value, null, 2) ?? "null" }
  } catch {
    return { isJson: false, text: String(value) }
  }
}

const highlightJson = (formatted: string): ReadonlyArray<ReactNode> => {
  const nodes: Array<ReactNode> = []
  let lastIndex = 0
  let key = 0
  for (const match of formatted.matchAll(JSON_TOKEN_PATTERN)) {
    const index = match.index ?? 0
    if (index > lastIndex) nodes.push(formatted.slice(lastIndex, index))
    const token = match[0]
    if (token.startsWith('"') && token.endsWith(":")) {
      const colonIndex = token.lastIndexOf(":")
      const keyPart = token.slice(0, colonIndex)
      const rest = token.slice(colonIndex)
      nodes.push(
        <span key={key++} className="text-chart-2 font-medium">
          {keyPart}
        </span>,
      )
      nodes.push(
        <span key={key++} className="text-muted-foreground">
          {rest}
        </span>,
      )
    } else if (token.startsWith('"')) {
      nodes.push(
        <span key={key++} className="text-positive">
          {token}
        </span>,
      )
    } else if (token === "true" || token === "false" || token === "null") {
      nodes.push(
        <span key={key++} className="text-chart-4 font-medium">
          {token}
        </span>,
      )
    } else if (/^[{}\[\]:,]$/.test(token)) {
      nodes.push(
        <span key={key++} className="text-muted-foreground">
          {token}
        </span>,
      )
    } else {
      nodes.push(
        <span key={key++} className="text-warning">
          {token}
        </span>,
      )
    }
    lastIndex = index + token.length
  }
  if (lastIndex < formatted.length) nodes.push(formatted.slice(lastIndex))
  return nodes
}

/** Scrollable formatted payload box that syntax-colors valid JSON using semantic theme tokens. */
export const FormattedPayload = memo(({
  value,
  emptyText,
  className,
  style,
  onNeededHeightChange,
  fitAlmostFull,
}: {
  readonly value: unknown
  readonly emptyText?: string
  readonly className?: string
  readonly style?: CSSProperties | undefined
  readonly onNeededHeightChange?: ((height: number) => void) | undefined
  readonly fitAlmostFull?: boolean | { readonly baseHeight?: number; readonly slack?: number }
}) => {
  const preRef = useRef<HTMLPreElement>(null)
  const codeRef = useRef<HTMLElement>(null)
  const fitBase =
    fitAlmostFull === true
      ? TOOL_PANE_BASE_HEIGHT
      : typeof fitAlmostFull === "object"
        ? (fitAlmostFull.baseHeight ?? TOOL_PANE_BASE_HEIGHT)
        : null
  const fitSlack =
    fitAlmostFull === true
      ? TOOL_PANE_ALMOST_FIT_SLACK
      : typeof fitAlmostFull === "object"
        ? (fitAlmostFull.slack ?? TOOL_PANE_ALMOST_FIT_SLACK)
        : TOOL_PANE_ALMOST_FIT_SLACK
  const [ownHeight, setOwnHeight] = useState<number | null>(null)

  const rendered = useMemo(() => {
    if ((value === undefined || value === null) && emptyText !== undefined) {
      return { kind: "empty" as const, text: emptyText }
    }
    const formatted = formatPayloadText(value)
    if (formatted.text === "" && emptyText !== undefined) {
      return { kind: "empty" as const, text: emptyText }
    }
    if (formatted.isJson && formatted.text.length <= JSON_HIGHLIGHT_MAX_CHARS) {
      return { kind: "json" as const, nodes: highlightJson(formatted.text) }
    }
    return { kind: "plain" as const, text: formatted.text }
  }, [emptyText, value])

  useLayoutEffect(() => {
    if (onNeededHeightChange === undefined && fitBase === null) return
    const pre = preRef.current
    const code = codeRef.current
    if (pre === null || code === null) return

    const measure = () => {
      const contentHeight = code.getBoundingClientRect().height
      if (contentHeight <= 0) return
      const computed = window.getComputedStyle(pre)
      const chrome =
        parseFloat(computed.paddingTop) +
        parseFloat(computed.paddingBottom) +
        parseFloat(computed.borderTopWidth) +
        parseFloat(computed.borderBottomWidth)
      const needed = Math.ceil(contentHeight + chrome) + 2
      onNeededHeightChange?.(needed)
      if (fitBase !== null) {
        const next = resolveScrollPaneHeight([needed], fitBase, fitSlack)
        const resolved = next > fitBase ? next : null
        setOwnHeight((prev) => (prev === resolved ? prev : resolved))
      }
    }

    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(code)
    return () => observer.disconnect()
  }, [fitBase, fitSlack, onNeededHeightChange, rendered])

  const mergedStyle: CSSProperties | undefined =
    ownHeight !== null ? { ...style, height: ownHeight } : style

  return (
    <pre
      ref={preRef}
      data-slot="formatted-payload"
      data-format={rendered.kind}
      style={mergedStyle}
      className={cn(
        "scrollbar-compact bg-muted/35 overflow-auto rounded-md border p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words",
        className,
      )}
    >
      <code ref={codeRef} className="block">
        {rendered.kind === "json" ? (
          rendered.nodes
        ) : rendered.kind === "empty" ? (
          <span className="text-muted-foreground italic">{rendered.text}</span>
        ) : (
          rendered.text
        )}
      </code>
    </pre>
  )
})
