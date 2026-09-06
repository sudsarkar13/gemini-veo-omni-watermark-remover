"use client"

import { AlertTriangle, ChevronRight, Crosshair, Trash2 } from "lucide-react"
import { useState } from "react"
import type { ManualMarkInput, ManualOutcomeSummary } from "@gvowr/ipc"

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
/**
 * A measured alpha outside this band, or a score under this floor, is not wrong — it
 * is unusual, and worth a person's eye.
 *
 * The bounds come from the calibration clip: the corner mark measures 0.96–1.06 and
 * the roaming one 1.17–1.25, both genuine. A bright rim that is not a mark at all
 * measured 1.32 at a score of 0.26. The distributions overlap, which is exactly why
 * this flags rather than rejects — see `PLAN.md` §2.2.
 */
const USUAL_ALPHA_MIN = 0.85
const USUAL_ALPHA_MAX = 1.3
const WEAK_SCORE = 0.35

export function MarkList({
  marks,
  outcomes,
  onEnableFill,
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
  /** What the last run made of each region. Empty before a run. */
  outcomes?: readonly ManualOutcomeSummary[]
  /** Turns the fill on for the next run, from a refused region's own row. */
  onEnableFill?: () => void
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
              <MarkStatus
                outcome={outcomes?.find((entry) => entry.markId === mark.id)}
                onEnableFill={onEnableFill}
                disabled={disabled}
              />
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

/**
 * What happened to one drawn region, in a word.
 *
 * Weak numbers are flagged, never hidden and never acted on: a region the verifier
 * accepted on thin evidence is the one place this tool can quietly damage a picture,
 * and the person who drew the box is better placed to judge it than any threshold —
 * measurement says no threshold separates the two cases.
 */
function MarkStatus({
  outcome,
  onEnableFill,
  disabled,
}: {
  outcome: ManualOutcomeSummary | undefined
  onEnableFill?: () => void
  disabled: boolean
}) {
  if (!outcome) return null

  if (outcome.filled > 0) {
    return (
      <span
        className="shrink-0 rounded bg-track-roaming/15 px-1.5 py-0.5 text-[10px] text-track-roaming"
        title={`${outcome.filled} region(s) synthesised from the surroundings — invented, not recovered`}
      >
        filled
      </span>
    )
  }

  if (outcome.removed === 0) {
    return (
      <span className="flex shrink-0 items-center gap-1">
        <span
          className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
          title="Nothing here inverted into its surroundings, so nothing was removed"
        >
          refused
        </span>
        {onEnableFill && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px]"
            disabled={disabled}
            onClick={onEnableFill}
            title="Switch on Fill and run again — pixels will be invented here"
          >
            Fill it
          </Button>
        )}
      </span>
    )
  }

  const weak =
    (outcome.confidence !== null && outcome.confidence < WEAK_SCORE) ||
    (outcome.alpha !== null && (outcome.alpha < USUAL_ALPHA_MIN || outcome.alpha > USUAL_ALPHA_MAX))

  const detail =
    `removed on ${outcome.removed} frame(s)` +
    (outcome.alpha !== null ? `, alpha ${outcome.alpha.toFixed(2)}` : "") +
    (outcome.confidence !== null ? `, score ${outcome.confidence.toFixed(2)}` : "")

  if (weak) {
    return (
      <span
        className="flex shrink-0 items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning"
        title={`${detail}. That is outside the range a real mark usually measures — worth checking this region in the comparison before you rely on it.`}
      >
        <AlertTriangle className="size-3" />
        check
      </span>
    )
  }

  return (
    <span
      className="shrink-0 rounded bg-success/15 px-1.5 py-0.5 text-[10px] text-success"
      title={detail}
    >
      removed
    </span>
  )
}
