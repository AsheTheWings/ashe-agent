import { memo, useEffect, useMemo, useRef, useState } from "react"
import { LayersIcon, Loader2Icon, WrenchIcon } from "lucide-react"
import type { ModelInputManifest, SemanticPageEntry } from "@ashe-agent/protocol"
import { useClient, useClientState } from "@/app/client-context.tsx"
import { Button } from "@/components/ui/button.tsx"
import { FormattedPayload } from "./json-view.tsx"
import { PlainText } from "./markdown.tsx"
import {
  SemanticBlockHeader,
  SemanticEntryContent,
  useAutoHydrateSemanticBody,
} from "./SessionView.tsx"
import { hasVisibleSemanticContent } from "./stats.ts"
import { formatBytes } from "./types.ts"

const MAX_RENDERED_CACHE = 80
const renderedBlobCache = new Map<string, string>()

const rememberRenderedBlob = (key: string, text: string) => {
  if (renderedBlobCache.has(key)) renderedBlobCache.delete(key)
  renderedBlobCache.set(key, text)
  if (renderedBlobCache.size > MAX_RENDERED_CACHE) {
    const oldest = renderedBlobCache.keys().next().value
    if (oldest !== undefined) renderedBlobCache.delete(oldest)
  }
}

const ContributionRow = memo(({
  contribution,
  matchedPageEntry,
  onOpenSession,
}: {
  readonly contribution: ModelInputManifest["contributions"][number]
  readonly matchedPageEntry: SemanticPageEntry | undefined
  readonly onOpenSession?: ((sessionId: string) => void) | undefined
}) => {
  const client = useClient()
  const sessionId = useClientState((state) => state.activeSessionId)
  const {
    hostRef,
    hydrated,
    loading: hydratingBody,
    error: bodyError,
    retry: retryBody,
  } = useAutoHydrateSemanticBody(sessionId, matchedPageEntry?.entry.id, matchedPageEntry?.body ?? null)

  const entry = hydrated ?? matchedPageEntry?.entry
  const pendingBody = hydrated === null && matchedPageEntry?.body !== null && matchedPageEntry !== undefined
  const semanticVisible = entry !== undefined && (pendingBody || hasVisibleSemanticContent(entry))

  const blobKey =
    sessionId !== null &&
    contribution.kind !== "tool-definition" &&
    contribution.kind !== "placeholder" &&
    !semanticVisible
      ? `${sessionId}:${contribution.rendered.contentId}:${contribution.rendered.representationId}`
      : null
  const [rawContent, setRawContent] = useState<string | null>(() =>
    blobKey !== null ? (renderedBlobCache.get(blobKey) ?? null) : null,
  )
  const [blobLoading, setBlobLoading] = useState(false)
  const [blobError, setBlobError] = useState<string | null>(null)
  const [blobAttempt, setBlobAttempt] = useState(0)
  const liRef = useRef<HTMLLIElement | null>(null)

  useEffect(() => {
    setRawContent(blobKey !== null ? (renderedBlobCache.get(blobKey) ?? null) : null)
    setBlobError(null)
  }, [blobKey])

  useEffect(() => {
    if (
      blobKey === null ||
      sessionId === null ||
      contribution.kind === "tool-definition" ||
      contribution.kind === "placeholder"
    ) {
      return
    }
    if (renderedBlobCache.has(blobKey)) {
      setRawContent(renderedBlobCache.get(blobKey)!)
      return
    }
    let cancelled = false
    let started = false
    const startFetch = () => {
      if (started || cancelled) return
      started = true
      setBlobLoading(true)
      setBlobError(null)
      void client
        .downloadContent(sessionId, contribution.rendered.contentId, contribution.rendered.representationId)
        .then((blob) => blob.text())
        .then((text) => {
          if (cancelled) return
          rememberRenderedBlob(blobKey, text)
          setRawContent(text)
        })
        .catch(() => {
          if (!cancelled) setBlobError("Retained representation is not directly downloadable.")
        })
        .finally(() => {
          if (!cancelled) setBlobLoading(false)
        })
    }

    const node = liRef.current
    if (node === null || typeof IntersectionObserver === "undefined") {
      startFetch()
      return () => {
        cancelled = true
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((candidate) => candidate.isIntersecting)) {
          observer.disconnect()
          startFetch()
        }
      },
      { rootMargin: "600px 0px" },
    )
    observer.observe(node)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [blobAttempt, blobKey, client, contribution, sessionId])

  const metaTag =
    contribution.kind === "placeholder" ? null : (
      <span className="text-muted-foreground/75 shrink-0 font-mono text-[11px] tabular-nums">
        #{contribution.position} · {contribution.rendered.mediaType} · {formatBytes(contribution.rendered.byteLength)} · {contribution.rendered.renderer}
      </span>
    )

  const renderedBlobBody =
    contribution.kind === "tool-definition" || contribution.kind === "placeholder" ? null : rawContent !== null ? (
      <FormattedPayload value={rawContent} className="max-h-96" />
    ) : blobError !== null ? (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{blobError}</span>
        <Button type="button" size="xs" variant="ghost" onClick={() => setBlobAttempt((n) => n + 1)}>
          Retry
        </Button>
      </div>
    ) : (
      <div className="text-muted-foreground flex items-center gap-2 py-1 text-xs">
        <Loader2Icon className={blobLoading ? "size-3.5 shrink-0 animate-spin" : "size-3.5 shrink-0"} />
        <span>Loading content ({formatBytes(contribution.rendered.byteLength)})…</span>
      </div>
    )

  return (
    <li
      ref={(node) => {
        liRef.current = node
        hostRef.current = node
      }}
      className="flex flex-col gap-2.5 py-5 text-sm [content-visibility:auto] [contain-intrinsic-size:auto_180px]"
    >
      {entry !== undefined ? (
        <>
          <SemanticBlockHeader entry={entry} onOpenSession={onOpenSession} extraRight={metaTag} />
          {pendingBody ? (
            <div className="text-muted-foreground flex items-center gap-2 py-1 text-xs">
              {bodyError !== null ? (
                <>
                  <span className="text-destructive">{bodyError}</span>
                  <Button type="button" size="xs" variant="ghost" onClick={retryBody}>
                    Retry
                  </Button>
                </>
              ) : (
                <>
                  <Loader2Icon className={hydratingBody ? "size-3.5 shrink-0 animate-spin" : "size-3.5 shrink-0"} />
                  <span>Loading content ({formatBytes(matchedPageEntry!.body!.byteLength)})…</span>
                </>
              )}
            </div>
          ) : semanticVisible ? (
            <SemanticEntryContent entry={entry} />
          ) : (
            renderedBlobBody
          )}
        </>
      ) : contribution.kind === "tool-definition" ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <div className="flex min-w-0 items-center gap-2">
              <WrenchIcon className="text-muted-foreground size-3.5 shrink-0" />
              <span className="font-mono font-semibold tracking-wide text-muted-foreground">
                tool definition · <span className="text-foreground">{contribution.name}</span>
              </span>
            </div>
            {metaTag}
          </div>
          <div className="flex flex-col gap-2">
            {contribution.description !== "" && (
              <PlainText text={contribution.description} className="text-xs leading-relaxed text-muted-foreground" />
            )}
            <FormattedPayload value={contribution.parameters} className="h-52" fitAlmostFull />
          </div>
        </>
      ) : contribution.kind === "placeholder" ? (
        <div className="flex flex-wrap items-baseline gap-2 text-xs">
          <span className="text-muted-foreground font-mono text-[11px] font-semibold tabular-nums">
            #{contribution.position}
          </span>
          <span className="font-medium text-muted-foreground">placeholder · {contribution.reason}</span>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-[11px]">
            <span className="font-mono font-semibold uppercase tracking-wide text-muted-foreground">
              {contribution.kind}
              {contribution.transformation !== null ? ` · ${contribution.transformation}` : ""}
            </span>
            {metaTag}
          </div>
          {renderedBlobBody}
        </>
      )}
    </li>
  )
})

export const Checkpoint = ({
  manifest,
  entries = [],
  onOpenSession,
}: {
  readonly manifest: ModelInputManifest | null
  readonly entries?: ReadonlyArray<SemanticPageEntry>
  readonly onOpenSession?: (sessionId: string) => void
}) => {
  const pageEntryById = useMemo(
    () => new Map<string, SemanticPageEntry>(entries.map((item) => [item.entry.id, item])),
    [entries],
  )
  const systemPageEntry = useMemo(
    () => entries.find((item) => item.entry.kind === "system"),
    [entries],
  )

  if (manifest === null) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 px-6 py-20 text-center sm:px-10 lg:px-12 xl:px-16">
        <div className="bg-muted flex size-10 items-center justify-center rounded-xl border">
          <LayersIcon className="size-5" />
        </div>
        <p className="text-sm font-medium text-foreground">No checkpoint boundary yet</p>
        <p className="max-w-sm text-xs">No successful model request is retained for this session yet.</p>
      </div>
    )
  }

  return (
    <div className="w-full px-6 sm:px-10 lg:px-12 xl:px-16">
      <ol className="divide-y divide-border">
        {manifest.contributions.map((contribution) => {
          const sourceId =
            contribution.kind === "placeholder" || contribution.kind === "tool-definition"
              ? null
              : (contribution.sourceEntryId ?? contribution.sourceEntryIds[0] ?? null)
          const matchedPageEntry =
            sourceId !== null
              ? pageEntryById.get(sourceId)
              : contribution.kind === "message" && contribution.transformation === "harness-system"
                ? systemPageEntry
                : undefined
          return (
            <ContributionRow
              key={contribution.position}
              contribution={contribution}
              matchedPageEntry={matchedPageEntry}
              onOpenSession={onOpenSession}
            />
          )
        })}
      </ol>
    </div>
  )
}
