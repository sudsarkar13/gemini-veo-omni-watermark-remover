"use client"

import { Crosshair, Trash2 } from "lucide-react"
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
 */
export function MarkList({
  marks,
  selectedId,
  frameRate,
  frameCount,
  onSelect,
  onChange,
  onRemove,
  onSeek,
  disabled,
}: {
  marks: readonly ManualMarkInput[]
  selectedId: string | null
  frameRate: number
  frameCount: number
  onSelect: (id: string) => void
  onChange: (mark: ManualMarkInput) => void
  onRemove: (id: string) => void
  onSeek: (frame: number) => void
  disabled: boolean
}) {
  if (marks.length === 0) return null

  const clamp = (value: number): number => Math.max(0, Math.min(frameCount - 1, value))

  return (
    <div className="rounded-md border border-border bg-surface">
      <div className="px-3 py-2 text-[11px] font-medium text-muted-foreground">
        Marked by hand — {marks.length} region{marks.length === 1 ? "" : "s"}
      </div>

      <ul className="divide-y divide-border">
        {marks.map((mark) => (
          <li
            key={mark.id}
            className={cn(
              "flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2",
              mark.id === selectedId && "bg-primary/5"
            )}
          >
            <button
              type="button"
              onClick={() => {
                onSelect(mark.id)
                onSeek(mark.fromFrame)
              }}
              className="flex items-center gap-2 text-[12px] hover:text-foreground"
            >
              <Crosshair className="size-3.5 text-muted-foreground" />
              <span className="tabular">
                {mark.rect.width}px at {mark.rect.x}, {mark.rect.y}
              </span>
            </button>

            <div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>frames</span>
              <Input
                type="number"
                min={0}
                max={frameCount - 1}
                disabled={disabled}
                className="h-7 w-20 text-[12px]"
                value={mark.fromFrame}
                onChange={(event) => {
                  const from = clamp(Number(event.target.value))
                  onChange({ ...mark, fromFrame: from, toFrame: Math.max(from, mark.toFrame) })
                }}
              />
              <span>to</span>
              <Input
                type="number"
                min={0}
                max={frameCount - 1}
                disabled={disabled}
                className="h-7 w-20 text-[12px]"
                value={mark.toFrame}
                onChange={(event) => {
                  const to = clamp(Number(event.target.value))
                  onChange({ ...mark, toFrame: to, fromFrame: Math.min(to, mark.fromFrame) })
                }}
              />
              <span className="w-24 text-right tabular">
                {formatTimecode(mark.fromFrame / frameRate)}–
                {formatTimecode(mark.toFrame / frameRate)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
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

      <p className="px-3 pb-2 text-[11px] text-muted-foreground">
        A region says where to look, not what to remove. The engine still measures the
        mark before touching anything, and reports any frame it could not.
      </p>
    </div>
  )
}
