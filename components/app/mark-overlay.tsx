"use client"

import { useCallback, useRef, useState } from "react"
import type { ManualMarkInput } from "@gvowr/ipc"

import { cn } from "@/lib/utils"

/**
 * Draws and edits the regions the user points at, in the coordinates of the clip.
 *
 * Everything here works in frame pixels and is projected onto whatever size the
 * player happens to be. Storing screen coordinates would tie a region to the window
 * it was drawn in, and the same mark would land somewhere else the moment the pane
 * was resized.
 *
 * The box is snapped square because the mark is square. A drawn region is a claim
 * about where the mark is, and the engine measures everything else — so letting the
 * user draw a lopsided rectangle would only invite them to express a precision that
 * changes nothing.
 */

/** Smallest region worth keeping, in frame pixels — below this it is a stray click. */
const MIN_SIZE = 12

export function MarkOverlay({
  marks,
  selectedId,
  frameWidth,
  frameHeight,
  currentFrame,
  frameCount,
  drawing,
  onCreate,
  onSelect,
}: {
  marks: readonly ManualMarkInput[]
  selectedId: string | null
  frameWidth: number
  frameHeight: number
  currentFrame: number
  frameCount: number
  /** While false the overlay is inert, so it never swallows a click on the video. */
  drawing: boolean
  onCreate: (mark: ManualMarkInput) => void
  onSelect: (id: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Where the drag began. A ref, not state, for the same reason as the draft below:
  // it is read by the very next pointer event, and a state value read there is one
  // render behind.
  const start = useRef<{ x: number; y: number } | null>(null)

  // The draft lives in a ref as well as in state. State drives what is drawn; the ref
  // is what gets committed, because a fast drag can finish inside a single React
  // batch and the release handler would otherwise read the box as it was one render
  // ago — dropping the region, or worse, saving a stale one.
  const draft = useRef<{ x: number; y: number; size: number } | null>(null)
  const [box, setBox] = useState<{ x: number; y: number; size: number } | null>(null)

  // The overlay covers the picture exactly, so a point in it maps to a frame pixel by
  // a single ratio — no letterbox arithmetic, because the element is the picture.
  const toFrame = useCallback(
    (event: React.PointerEvent): { x: number; y: number } | null => {
      const element = ref.current
      if (!element) return null
      const bounds = element.getBoundingClientRect()
      if (bounds.width === 0 || bounds.height === 0) return null
      return {
        x: Math.round(((event.clientX - bounds.left) / bounds.width) * frameWidth),
        y: Math.round(((event.clientY - bounds.top) / bounds.height) * frameHeight),
      }
    },
    [frameWidth, frameHeight]
  )

  const square = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const size = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
    return {
      x: Math.max(0, Math.min(a.x, b.x, frameWidth - size)),
      y: Math.max(0, Math.min(a.y, b.y, frameHeight - size)),
      size,
    }
  }

  const visible = marks.filter(
    (mark) => currentFrame >= mark.fromFrame && currentFrame <= mark.toFrame
  )

  return (
    <div
      ref={ref}
      className={cn(
        "absolute inset-0 z-20",
        drawing ? "cursor-crosshair" : "pointer-events-none"
      )}
      onPointerDown={(event) => {
        if (!drawing) return
        const point = toFrame(event)
        if (!point) return
        event.currentTarget.setPointerCapture(event.pointerId)
        start.current = point
        draft.current = { ...point, size: 0 }
        setBox(draft.current)
      }}
      onPointerMove={(event) => {
        const origin = start.current
        if (!origin) return
        const point = toFrame(event)
        if (!point) return
        draft.current = square(origin, point)
        setBox(draft.current)
      }}
      onPointerUp={() => {
        const finished = draft.current
        if (finished && finished.size >= MIN_SIZE) {
          onCreate({
            id: `mark-${Date.now().toString(36)}`,
            rect: {
              x: finished.x,
              y: finished.y,
              width: finished.size,
              height: finished.size,
            },
            // From here to the end of the clip: a mark that has appeared usually stays
            // for the rest of the shot, and shortening a range is easier than
            // discovering that the default was too timid.
            fromFrame: currentFrame,
            toFrame: Math.max(currentFrame, frameCount - 1),
          })
        }
        draft.current = null
        start.current = null
        setBox(null)
      }}
    >
      {visible.map((mark) => (
        <button
          key={mark.id}
          type="button"
          aria-label={`Region at ${mark.rect.x}, ${mark.rect.y}`}
          onClick={() => onSelect(mark.id)}
          className={cn(
            "absolute border-2 bg-primary/5 transition-colors",
            drawing ? "pointer-events-auto" : "pointer-events-none",
            mark.id === selectedId
              ? "border-primary shadow-[0_0_0_1px_var(--background)]"
              : "border-primary/50"
          )}
          style={{
            left: `${(mark.rect.x / frameWidth) * 100}%`,
            top: `${(mark.rect.y / frameHeight) * 100}%`,
            width: `${(mark.rect.width / frameWidth) * 100}%`,
            height: `${(mark.rect.height / frameHeight) * 100}%`,
          }}
        />
      ))}

      {box && (
        <div
          aria-hidden
          className="absolute border-2 border-primary bg-primary/10"
          style={{
            left: `${(box.x / frameWidth) * 100}%`,
            top: `${(box.y / frameHeight) * 100}%`,
            width: `${(box.size / frameWidth) * 100}%`,
            height: `${(box.size / frameHeight) * 100}%`,
          }}
        />
      )}
    </div>
  )
}
