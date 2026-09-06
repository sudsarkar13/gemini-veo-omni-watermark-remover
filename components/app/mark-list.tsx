"use client"

import { ChevronRight, Crosshair, Trash2 } from "lucide-react"
import { useState } from "react"
import type { ManualMarkInput } from "@gvowr/ipc"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatTimecode } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * The regions the user has drawn, and the frames each applies to.
 *
 * Ranges are shown in frames rather than seconds because that is the unit the person
 * doing this is working in — they arrived here by stepping frame by frame to find the
 * mark, and rounding that to tenths of a second would lose the frame they found.
 * Timecode sits alongside for orientation.
 *
 * The list is bounded and scrolls within itself. Marking one region per frame is a
 * perfectly reasonable way to chase a mark that moves, and a list that grows a row
 * per frame will happily push the picture off the screen — which takes the space away
 * from precisely the thing you need in order to draw the next one.
 */
export function MarkList({
  marks,
  still = false,
  selectedId,
  frameRate,
  frameCount,
  onSelect,
  onChange,
  onRemove,
  onClear,
  onSeek,
  disabled,
}: {
  marks: readonly ManualMarkInput[]
  /** On a still there is one frame, so a frame range is not a thing to edit. */
  still?: boolean
  selectedId: string | null
  frameRate: number
  frameCount: number
  onSelect: (id: string) => void
  onChange: (mark: ManualMarkInput) => void
  onRemove: (id: string) => void
  onClear: () => void
  onSeek: (frame: number) => void
  disabled: boolean
}) {
  // Folded state is the user's, not derived from how many regions there happen to be:
  // a panel that collapses itself the moment you draw a fourth region is a panel that
  // moves under your hand.
  const [open, setOpen] = useState(true)

  if (marks.length === 0) return null

  const clamp = (value: number): number => Math.max(0, Math.min(frameCount - 1, value))

  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          Marked by hand — {marks.length} region{marks.length === 1 ? "" : "s"}
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px] text-muted-foreground"
          disabled={disabled}
          onClick={() => onClear()}
        >
          Clear all
        </Button>
      </div>

      {/* Three rows, then it scrolls, and it folds away entirely.
       *
       * Marking one region per frame is a reasonable way to chase a mark that moves,
       * and a list that grows a row per frame will push the picture off the screen —
       * taking the space from precisely the thing you need in order to draw the next
       * one. */}
      <ul
        hidden={!open}
        className="max-h-[5.75rem] divide-y divide-border overflow-y-auto overscroll-contain border-t border-border"
      >
        {marks.map((mark) => (
          <li
            key={mark.id}
            className={cn(
              "flex items-center gap-x-2 px-3 py-1",
              mark.id === selectedId && "bg-primary/5"
            )}
          >
            <button
              type="button"
              onClick={() => {
                onSelect(mark.id)
                onSeek(mark.fromFrame)
              }}
              className="flex shrink-0 items-center gap-1.5 text-[11px] hover:text-foreground"
            >
              <Crosshair className="size-3 text-muted-foreground" />
              <span className="tabular">
                {mark.rect.width}px · {mark.rect.x},{mark.rect.y}
              </span>
            </button>

            <div className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
              {/* One frame means no range to edit and no timecode to show. */}
              {!still && (
                <>
              <Input
                type="number"
                min={0}
                max={frameCount - 1}
                aria-label="First frame"
                disabled={disabled}
                className="h-6 w-16 px-1.5 text-[11px]"
                value={mark.fromFrame}
                onChange={(event) => {
                  const from = clamp(Number(event.target.value))
                  onChange({ ...mark, fromFrame: from, toFrame: Math.max(from, mark.toFrame) })
                }}
              />
              <span>–</span>
              <Input
                type="number"
                min={0}
                max={frameCount - 1}
                aria-label="Last frame"
                disabled={disabled}
                className="h-6 w-16 px-1.5 text-[11px]"
                value={mark.toFrame}
                onChange={(event) => {
                  const to = clamp(Number(event.target.value))
                  onChange({ ...mark, toFrame: to, fromFrame: Math.min(to, mark.fromFrame) })
                }}
              />
              <span className="w-20 text-right tabular">
                {formatTimecode(mark.fromFrame / frameRate)}–
                {formatTimecode(mark.toFrame / frameRate)}
              </span>
                </>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label="Remove region"
                disabled={disabled}
                onClick={() => onRemove(mark.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {open && (
        <p className="border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
          A region says where to look, not what to remove — the engine still measures
          the mark before touching anything.
        </p>
      )}
    </div>
  )
}
