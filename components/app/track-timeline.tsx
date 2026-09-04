"use client"

import type { JobResult } from "@gvowr/ipc"

import { formatTimecode } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * Summary of what was found and corrected.
 *
 * This is where the project's distinguishing capability becomes visible: the engine
 * models a *set of tracks* through time rather than one fixed rectangle, so a mark
 * that appears mid-clip and moves is representable and reportable.
 *
 * Frames deliberately left untouched are always shown. Reporting a clip as simply
 * clean when some frames still carry the mark would hide exactly what needs checking.
 */
export function TrackSummary({
  result,
  durationSeconds,
}: {
  result: JobResult
  durationSeconds: number
}) {
  const corrected = result.framesCorrected
  const skipped = result.framesLeftUntouched
  const total = corrected + skipped
  const skippedFraction = total > 0 ? skipped / total : 0

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Detection
        </h3>
        <span className="text-[11px] text-muted-foreground tabular">
          {formatTimecode(durationSeconds)}
        </span>
      </div>

      <div className="mt-2.5 flex items-center gap-1.5" aria-hidden>
        <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="bg-track-corner"
            style={{ width: `${(1 - skippedFraction) * 100}%` }}
          />
          <div
            className="bg-track-occluded"
            style={{ width: `${skippedFraction * 100}%` }}
          />
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
        <Row label="Watermarks tracked" value={result.tracksFound} />
        <Row label="Candidates rejected" value={result.tracksRejected} />
        <Row label="Frames corrected" value={corrected} />
        <Row
          label="Left untouched"
          value={skipped}
          emphasis={skipped > 0 ? "warning" : undefined}
        />
      </dl>

      {skipped > 0 && (
        <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
          The mark could not be located on {skipped} frame{skipped === 1 ? "" : "s"},
          usually because something in the scene passed in front of it. Those frames were
          left as they were rather than corrected with a guessed position.
        </p>
      )}
    </div>
  )
}

function Row({
  label,
  value,
  emphasis,
}: {
  label: string
  value: number
  emphasis?: "warning"
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-right font-medium tabular",
          emphasis === "warning" && "text-warning"
        )}
      >
        {value.toLocaleString()}
      </dd>
    </>
  )
}
