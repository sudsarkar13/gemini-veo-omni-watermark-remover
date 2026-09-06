"use client"

import { AlertTriangle, Check, Loader2, RefreshCw } from "lucide-react"
import type { ResidualSummary } from "@gvowr/ipc"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * What the finished render still shows, in a word.
 *
 * This is the only number in the app that describes the *output* rather than the
 * plan's account of itself, so it is deliberately the one that can contradict all the
 * others. A run can report two hundred frames corrected, no skips and no failure, and
 * still land here saying the file carries a mark — that disagreement is the feature.
 *
 * It never reads "clean". What the check established is that the detector looked and
 * found nothing, which is a weaker claim than the picture being unmarked, and the
 * wording has to keep those apart. See `UI-SPEC.md` §5.10.
 */
export function ResidualBadge({
  residual,
  checking = false,
  onCheck,
  onJump,
  className,
}: {
  residual: ResidualSummary | null
  checking?: boolean
  /** Runs the check again. Omitted where there is no stored file left to check. */
  onCheck?: () => void
  /** Seeks to the first flagged frame. Omitted on a still, which has only one. */
  onJump?: (frame: number) => void
  className?: string
}) {
  if (checking) {
    return (
      <span className={cn(chip, "bg-muted text-muted-foreground", className)}>
        <Loader2 className="size-3 animate-spin" />
        checking…
      </span>
    )
  }

  if (!residual) {
    return (
      <span className={cn("flex items-center gap-1", className)}>
        <span className={cn(chip, "bg-muted text-muted-foreground")} title={NOT_CHECKED}>
          not checked
        </span>
        {onCheck && <CheckAgain onCheck={onCheck} label="Check" />}
      </span>
    )
  }

  if (residual.framesMarked === 0) {
    return (
      <span className={cn("flex items-center gap-1", className)}>
        <span
          className={cn(chip, "bg-success/15 text-success")}
          title={`The detector swept ${residual.framesChecked} frame(s) of the finished file and found nothing still reading as a mark. That is not the same as a guarantee the picture is unmarked.`}
        >
          <Check className="size-3" />
          no leftovers found
        </span>
        {onCheck && <CheckAgain onCheck={onCheck} label="Re-check" />}
      </span>
    )
  }

  const first = residual.ranges[0]

  return (
    <span className={cn("flex items-center gap-1", className)}>
      <button
        type="button"
        onClick={first && onJump ? () => onJump(first.from) : undefined}
        disabled={!first || !onJump}
        className={cn(
          chip,
          "bg-warning/15 text-warning",
          first && onJump && "hover:bg-warning/25"
        )}
        title={describe(residual)}
      >
        <AlertTriangle className="size-3" />
        {residual.framesMarked} frame{residual.framesMarked === 1 ? "" : "s"} still marked
      </button>
      {onCheck && <CheckAgain onCheck={onCheck} label="Re-check" />}
    </span>
  )
}

const chip =
  "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-tight"

const NOT_CHECKED =
  "Nothing has looked at this render yet. Every other number on it describes what the engine decided to do, not what came out."

function CheckAgain({ onCheck, label }: { onCheck: () => void; label: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground"
      onClick={onCheck}
      title="Read the finished file back and look for anything that still reads as a mark"
    >
      <RefreshCw className="size-2.5" />
      {label}
    </Button>
  )
}

/**
 * The tooltip, including the part that is uncertain.
 *
 * A range's start is the first frame the check *confirmed*, not necessarily the first
 * frame the mark was on — leftovers are followed forward from a sampled frame and the
 * earlier frames are already decoded and gone. Saying so costs a sentence; widening
 * the range to the previous sample would present a guess as a measurement.
 */
function describe(residual: ResidualSummary): string {
  const ranges = residual.ranges
    .slice(0, 4)
    .map((range) => {
      const span = range.from === range.to ? `frame ${range.from}` : `frames ${range.from}–${range.to}`
      // The strength matters as much as the location. Half a mark left behind and a
      // faint trace of one are both "still marked" and are not the same problem, and
      // the alpha is the only thing here that tells them apart.
      return `${span} (${range.kind}, alpha ${range.peakAlpha.toFixed(2)})`
    })
    .join(", ")
  const more = residual.ranges.length > 4 ? `, and ${residual.ranges.length - 4} more` : ""
  return (
    `Still reads as marked at ${ranges}${more}. ` +
    `Each range starts where the mark was confirmed; the check samples every ` +
    `${residual.sweepInterval} frames, so it may have appeared a little earlier.`
  )
}
