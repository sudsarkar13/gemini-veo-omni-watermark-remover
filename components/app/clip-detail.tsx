"use client"

import {
  AlertTriangle,
  FolderOpen,
  Play,
  SearchX,
  Square,
} from "lucide-react"
import { useState } from "react"
import type { Job, JobOptions } from "@gvowr/ipc"

import { AdvancedDrawer, DEFAULT_OPTIONS } from "@/components/app/advanced-drawer"
import { LiveMeters } from "@/components/app/live-meters"
import { Preflight } from "@/components/app/preflight"
import { TrackSummary } from "@/components/app/track-timeline"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { formatBytes, formatDuration } from "@/lib/format"

/**
 * The right-hand pane: everything about the selected clip, and the controls to act
 * on it.
 *
 * A frame preview is not here yet. Showing before/after needs decoded frames, and the
 * IPC contract deliberately carries no pixels — adding that means a separate
 * thumbnail channel. Rather than mock it, the pane reports what is genuinely known.
 */
export function ClipDetail({
  job,
  onStart,
  onCancel,
  onReveal,
}: {
  job: Job
  onStart: (options: JobOptions) => void
  onCancel: () => void
  onReveal: () => void
}) {
  const [options, setOptions] = useState<JobOptions>(DEFAULT_OPTIONS)

  const busy = job.state === "analysing" || job.state === "processing"
  const runnable = job.state === "ready" || job.state === "queued"
  const rerunnable = ["done", "done-with-skips", "no-mark-found", "failed", "cancelled"].includes(
    job.state
  )

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <ScrollArea className="flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-5">
          <header className="flex flex-col gap-1">
            <h1 className="truncate text-[15px] font-semibold" title={job.inputPath}>
              {job.fileName}
            </h1>
            {job.info && (
              <p className="text-[12px] text-muted-foreground tabular">
                {job.info.width}×{job.info.height} · {job.info.videoCodec} ·{" "}
                {job.info.frameRate.toFixed(2)} fps ·{" "}
                {formatDuration(job.info.durationSeconds)} ·{" "}
                {formatBytes(job.info.sizeBytes)} ·{" "}
                {job.info.hasAudio ? `audio ${job.info.audioCodec ?? ""}`.trim() : "no audio"}
              </p>
            )}
          </header>

          {job.info && !job.info.calibratedResolution && (
            <Badge variant="secondary" className="w-fit gap-1.5 font-normal">
              <AlertTriangle className="size-3" />
              Uncalibrated resolution — using a generic estimate of the mark&apos;s position
            </Badge>
          )}

          {job.error && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>This clip could not be processed</AlertTitle>
              <AlertDescription>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] opacity-90">
                  {job.error}
                </pre>
              </AlertDescription>
            </Alert>
          )}

          {job.state === "no-mark-found" && (
            <Alert>
              <SearchX className="size-4" />
              <AlertTitle>No watermark found</AlertTitle>
              <AlertDescription>
                Nothing in this clip inverted cleanly into its surroundings, so nothing was
                changed. If you can see a mark, try Full-frame sweep in Advanced, or adjust
                the mark size to match what you see.
              </AlertDescription>
            </Alert>
          )}

          {busy && job.progress && <LiveMeters progress={job.progress} />}

          {!busy && job.info && job.estimate && (runnable || rerunnable) && (
            <Preflight info={job.info} estimate={job.estimate} />
          )}

          {job.result && (
            <TrackSummary
              result={job.result}
              durationSeconds={job.info?.durationSeconds ?? 0}
            />
          )}

          <AdvancedDrawer options={options} onChange={setOptions} disabled={busy} />
        </div>
      </ScrollArea>

      <footer className="flex items-center justify-between gap-3 border-t border-border bg-sidebar px-5 py-3">
        <div className="min-w-0 text-[11px] text-muted-foreground">
          {job.result ? (
            <span className="truncate" title={job.result.outputPath}>
              Saved to {job.result.outputPath}
            </span>
          ) : (
            <span>Output is written next to the original.</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {job.result && (
            <Button variant="secondary" size="sm" onClick={onReveal}>
              <FolderOpen className="size-4" />
              Show file
            </Button>
          )}
          {busy ? (
            <Button variant="destructive" size="sm" onClick={onCancel}>
              <Square className="size-3.5" />
              Cancel
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!job.info}
              onClick={() => onStart(options)}
            >
              <Play className="size-4" />
              {rerunnable ? "Run again" : "Remove watermark"}
            </Button>
          )}
        </div>
      </footer>
    </section>
  )
}
