import { useEffect, useRef, useState } from "react"
import { cn } from "cn"

/**
 * Vertical split resize handle matching Claude's zero-width hit-target pattern:
 * a 12px pointer hit strip centered on the border with a 2px highlight pill on hover, focus, or active drag.
 */
export const VerticalResizeHandle = ({
  label,
  valueNow,
  valueMin,
  valueMax,
  onDragDelta,
  onStep,
  onReset,
}: {
  readonly label: string
  readonly valueNow: number
  readonly valueMin: number
  readonly valueMax: number
  readonly onDragDelta: (deltaX: number) => void
  readonly onStep: (delta: number) => void
  readonly onReset?: () => void
}) => {
  const [dragging, setDragging] = useState(false)
  const dragState = useRef<{ lastX: number } | null>(null)
  const onDragDeltaRef = useRef(onDragDelta)
  onDragDeltaRef.current = onDragDelta

  useEffect(() => {
    if (!dragging) return
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"

    const onPointerMove = (event: PointerEvent) => {
      const state = dragState.current
      if (state === null) return
      const delta = event.clientX - state.lastX
      if (delta === 0) return
      state.lastX = event.clientX
      onDragDeltaRef.current(delta)
    }

    const endDrag = () => {
      dragState.current = null
      setDragging(false)
    }

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", endDrag)
    window.addEventListener("pointercancel", endDrag)
    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", endDrag)
      window.removeEventListener("pointercancel", endDrag)
    }
  }, [dragging])

  return (
    <div className="relative z-30 hidden w-0 shrink-0 md:block">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={Math.round(valueNow)}
        aria-valuemin={Math.round(valueMin)}
        aria-valuemax={Math.round(valueMax)}
        tabIndex={0}
        data-dragging={dragging ? "true" : "false"}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          dragState.current = { lastX: event.clientX }
          setDragging(true)
        }}
        onDoubleClick={() => onReset?.()}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault()
            onStep(-1)
          } else if (event.key === "ArrowRight") {
            event.preventDefault()
            onStep(1)
          } else if (event.key === "Home" || event.key === "Enter") {
            if (onReset !== undefined) {
              event.preventDefault()
              onReset()
            }
          }
        }}
        className="group/resize absolute inset-y-0 left-0 w-3 -translate-x-1/2 cursor-col-resize outline-none"
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 rounded-full transition-colors duration-150",
            dragging
              ? "bg-ring"
              : "bg-transparent group-hover/resize:bg-ring/70 group-focus-visible/resize:bg-ring",
          )}
        />
      </div>
    </div>
  )
}
