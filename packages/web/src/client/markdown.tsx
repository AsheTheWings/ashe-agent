import { CheckIcon, CopyIcon, ExternalLinkIcon, ImageIcon } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "cn"
import { Button } from "@/components/ui/button.tsx"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard.ts"

const SAFE_URL = /^https?:\/\//i

/** External images stay inert until their own Load control is used. */
export const ExternalImage = ({ alt, url }: { readonly alt: string; readonly url: string }) => {
  const [state, setState] = useState<"idle" | "loading" | "refused">("idle")
  const [src, setSrc] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const load = () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setState("loading")
    void fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", mode: "cors", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`the server answered ${response.status}`)
        const type = response.headers.get("content-type") ?? ""
        if (!/^image\/(png|jpeg|webp|gif)/.test(type)) throw new Error("the response is not a raster image")
        const limit = 10 * 1024 * 1024
        if (Number(response.headers.get("content-length") ?? 0) > limit) throw new Error("the image is too large")
        const reader = response.body?.getReader()
        if (reader === undefined) throw new Error("the image has no body")
        const chunks: Array<ArrayBuffer> = []
        let size = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > limit) {
            await reader.cancel()
            throw new Error("the image is too large")
          }
          chunks.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer)
        }
        return new Blob(chunks, { type })
      })
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob)
        if (!mountedRef.current || controller.signal.aborted) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        setSrc(objectUrl)
      })
      .catch(() => {
        if (mountedRef.current && !controller.signal.aborted) setState("refused")
      })
  }
  useEffect(() => () => {
    if (src !== null) URL.revokeObjectURL(src)
  }, [src])

  return (
    <span className="bg-muted/40 my-2 inline-flex max-w-full flex-col gap-1.5 rounded-lg border p-2.5 text-xs">
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">External image: {alt || url}</span>
      </span>
      <span className="text-muted-foreground break-all font-mono text-[11px]">{url}</span>
      {src === null ? (
        <span className="flex items-center gap-2 pt-0.5">
          <Button type="button" size="xs" variant="outline" disabled={state === "loading"} onClick={load}>
            {state === "loading" ? "Loading…" : "Load"}
          </Button>
          {state === "refused" && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary inline-flex items-center gap-1 underline underline-offset-2"
            >
              Open image instead
              <ExternalLinkIcon className="size-3" />
            </a>
          )}
        </span>
      ) : (
        <img src={src} alt={alt} className="max-h-96 max-w-full rounded-md border object-contain" />
      )}
    </span>
  )
}

const CodeFence = ({ language, text }: { readonly language: string | null; readonly text: string }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  return (
    <div className="bg-muted/50 my-2.5 overflow-hidden rounded-lg border">
      <div className="bg-muted/60 flex items-center justify-between border-b px-3 py-1 text-[11px] text-muted-foreground">
        <span className="font-mono">{language ?? "code"}</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="h-5 px-1.5 text-[11px]"
          onClick={() => copyToClipboard(text)}
        >
          {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          {isCopied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="scrollbar-compact overflow-x-auto p-3 font-mono text-xs leading-relaxed">
        <code>{text}</code>
      </pre>
    </div>
  )
}

const extractText = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(extractText).join("")
  if (node !== null && typeof node === "object" && "props" in node) {
    return extractText((node as { props?: { children?: ReactNode } }).props?.children)
  }
  return ""
}

const markdownComponents: Components = {
  p: ({ children }) => <p className="mb-2.5 last:mb-0 leading-6">{children}</p>,
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-lg font-semibold tracking-tight first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-base font-semibold tracking-tight first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h3>,
  ul: ({ children }) => <ul className="mb-2.5 ml-5 list-disc space-y-1 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2.5 ml-5 list-decimal space-y-1 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="leading-6">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-primary/40 text-muted-foreground my-2.5 border-l-2 pl-3 italic">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    <div className="scrollbar-compact my-2.5 overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/60 border-b">{children}</thead>,
  th: ({ children }) => <th className="px-2.5 py-1.5 font-medium text-foreground">{children}</th>,
  td: ({ children }) => <td className="border-t px-2.5 py-1.5 align-top">{children}</td>,
  a: ({ href, children }) =>
    href !== undefined && SAFE_URL.test(href) ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ src, alt }) =>
    src !== undefined && SAFE_URL.test(src) ? (
      <ExternalImage alt={alt ?? ""} url={src} />
    ) : (
      <span className="text-muted-foreground text-xs">[image: {alt ?? "blocked"}]</span>
    ),
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children
    const props = (child !== null && typeof child === "object" && "props" in child
      ? (child as { props?: { className?: string; children?: ReactNode } }).props
      : undefined)
    const match = /language-([^\s]+)/.exec(props?.className ?? "")
    const text = extractText(props?.children ?? children).replace(/\n$/, "")
    return <CodeFence language={match?.[1] ?? null} text={text} />
  },
  code: ({ className, children }) => {
    if (className?.includes("language-")) {
      return <code className={className}>{children}</code>
    }
    return <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  },
}

/** Safe GFM Markdown renderer: no raw HTML evaluation, validated links, consent-gated external images. */
export const MarkdownText = ({ text, className }: { readonly text: string; readonly className?: string }) => (
  <div className={cn("min-w-0 break-words text-sm", className)}>
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>
      {text}
    </Markdown>
  </div>
)

const mediaPattern = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g

/** Plain-text renderer preserving whitespace and turning markdown image links into consent placeholders. */
export const PlainText = ({ text, className }: { readonly text: string; readonly className?: string }) => {
  const parts: Array<ReactNode> = []
  let offset = 0
  for (const match of text.matchAll(mediaPattern)) {
    const index = match.index ?? 0
    if (index > offset) parts.push(text.slice(offset, index))
    parts.push(<ExternalImage key={`${index}:${match[2]}`} alt={match[1] ?? ""} url={match[2]!} />)
    offset = index + match[0].length
  }
  if (offset < text.length) parts.push(text.slice(offset))
  return <div className={cn("whitespace-pre-wrap break-words", className)}>{parts.length === 0 ? text : parts}</div>
}
