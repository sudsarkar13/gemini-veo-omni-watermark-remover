"use client"

import type { JobProgress } from "@gvowr/ipc"

import { Progress } from "@/components/ui/progress"
import { formatDuration } from "@/lib/format"

/**
 * Live progress during a run.
 *
 * Frames per second is the number that actually tells someone whether a long job is
 * healthy or thrashing, which is why it is shown alongside the percentage rather than
 * a bare spinner. All figures use tabular numerals so they do not jitter in place.
 */
export function LiveMeters({ progress }: { progress: JobProgress }) {
  const percent = Math.round(progress.fraction * 100)
  const stage = progress.stage === "analysing" ? "Analysing" : "Rendering"

  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-medium">
          {stage}
          <span className="ml-2 text-muted-foreground tabular">
            {progress.frame.toLocaleString()} / {progress.totalFrames.toLocaleString()} frames
          </span>
        </span>
        <span className="text-[12px] font-medium tabular">{percent}%</span>
      </div>

      <Progress value={percent} className="mt-2 h-1.5" />

      <div className="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground tabular">
        <span>{progress.framesPerSecond.toFixed(1)} fps</span>
        <span>
          {progress.etaSeconds === null
            ? "estimating…"
            : `${formatDuration(progress.etaSeconds)} left`}
        </span>
      </div>
    </div>
  )
}
