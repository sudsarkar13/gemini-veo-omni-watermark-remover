"use client"

import { AlertTriangle, FolderOpen, Play, SearchX, Square } from "lucide-react"
import { useState } from "react"
import type { Job, JobOptions, ManualMarkInput } from "@gvowr/ipc"

import { AdvancedDrawer, DEFAULT_OPTIONS } from "@/components/app/advanced-drawer"
import { ComparePlayer } from "@/components/app/compare-player"
import { MarkList } from "@/components/app/mark-list"
import { MarkOverlay } from "@/components/app/mark-overlay"
import { LiveMeters } from "@/components/app/live-meters"
import { Preflight } from "@/components/app/preflight"
import { Timeline } from "@/components/app/timeline"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useClipMedia } from "@/hooks/use-desktop"
import { formatBytes, formatDuration } from "@/lib/format"

/**
 * The editing surface for one clip, laid out as docked regions rather than one long
 * scrolling column.
 *
 * An editor's frame does not move. The player takes whatever height is left over, the
 * timeline sits under it, the inspector below that scrolls within its own bounds, and
 * the action bar is pinned — so Run is reachable at every window size and in every
 * state. A single scrolling column looked fine until a 16:9 player claimed the whole
 * viewport and pushed the only button that matters past the bottom edge.
 *
 * Every flexible region carries `min-h-0`. Flex items default to `min-height: auto`,
 * which means "never shrink below your content" — a scroll container with that default
 * grows to fit instead of scrolling, which is exactly how the action bar disappeared.
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
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(job.info?.durationSeconds ?? 0)
  const [marks, setMarks] = useState<ManualMarkInput[]>([])
  const [selectedMark, setSelectedMark] = useState<string | null>(null)
  const [marking, setMarking] = useState(false)

  const frameRate = job.info?.frameRate ?? 30
  const frameCount = job.info?.frameCount ?? 0
  const currentFrame = Math.min(Math.max(0, Math.round(currentTime * frameRate)), Math.max(0, frameCount - 1))
  const seekToFrame = (frame: number): void => setCurrentTime(frame / frameRate)

  // Keyed on the output path so a finished run reloads the media and the comparison
  // shows the render that just completed rather than a stale one.
  const media = useClipMedia(job.id, job.result?.outputPath ?? null)

  const busy = job.state === "analysing" || job.state === "processing"
  const rerunnable = ["done", "done-with-skips", "no-mark-found", "failed", "cancelled"].includes(
    job.state
  )

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5">
        <h1 className="min-w-0 truncate text-[14px] font-semibold" title={job.inputPath}>
          {job.fileName}
        </h1>
        {job.info && (
          <p className="text-[11px] text-muted-foreground tabular">
            {job.info.width}×{job.info.height} · {job.info.videoCodec} ·{" "}
            {job.info.frameRate.toFixed(2)} fps · {formatDuration(job.info.durationSeconds)} ·{" "}
            {formatBytes(job.info.sizeBytes)} ·{" "}
            {job.info.hasAudio ? `audio ${job.info.audioCodec ?? ""}`.trim() : "no audio"}
          </p>
        )}
      </header>

      {/*
       * Stage — the player absorbs the slack, the timeline keeps its own height.
       *
       * The floor matters at the minimum window size with the drawer open: without it
       * the inspector's share squeezes the picture down to a postage stamp, and a
       * video tool whose video has been squeezed out is not one.
       */}
      <div className="flex min-h-[200px] flex-1 flex-col gap-2 px-4 pb-2">
        {media ? (
          <ComparePlayer
            className="min-h-0 flex-1"
            media={media}
            frameRate={frameRate}
            frameWidth={job.info?.width ?? 0}
            currentTime={currentTime}
            onTimeChange={setCurrentTime}
            onDurationChange={setDuration}
            marking={marking}
            onMarkingChange={setMarking}
            canMark={!busy && job.info !== null}
            overlay={
              job.info ? (
                <MarkOverlay
                  marks={marks}
                  selectedId={selectedMark}
                  frameWidth={job.info.width}
                  frameHeight={job.info.height}
                  currentFrame={currentFrame}
                  frameCount={frameCount}
                  drawing={marking}
                  onSelect={setSelectedMark}
                  onCreate={(mark) => {
                    setMarks((current) => [...current, mark])
                    setSelectedMark(mark.id)
                  }}
                />
              ) : null
            }
          />
        ) : (
          <Skeleton className="min-h-0 flex-1 rounded-md" />
        )}

        {media && (
          <Timeline
            className="shrink-0"
            jobId={job.id}
            media={media}
            duration={duration || (job.info?.durationSeconds ?? 0)}
            currentTime={currentTime}
            frameCount={job.info?.frameCount ?? 0}
            onSeek={setCurrentTime}
            result={job.result}
          />
        )}
      </div>

      {/*
       * Inspector. Sizes to its content and scrolls once it would take more than its
       * share of the window — and yields further to the stage's floor before that,
       * since it can always scroll and the picture cannot. Either way the action bar
       * below it stays put.
       */}
      <div className="max-h-[30%] min-h-0 overflow-y-auto overscroll-contain border-t border-border">
        <div className="flex flex-col gap-2 px-4 py-3">
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

          {job.result && job.result.framesUncovered > 0 && (
            <Alert className="border-warning/40 bg-warning/5 text-foreground">
              <AlertTriangle className="size-4 text-warning" />
              <AlertTitle className="text-warning">
                {job.result.framesUncovered} frame
                {job.result.framesUncovered === 1 ? "" : "s"} still carry the watermark
              </AlertTitle>
              <AlertDescription className="text-muted-foreground">
                The mark was tracked across most of the clip but lost at{" "}
                {job.result.uncoveredRanges
                  .map((range) =>
                    range.from === range.to
                      ? `frame ${range.from}`
                      : `frames ${range.from}–${range.to}`
                  )
                  .join(", ")}
                , and nothing was applied there — they are marked in orange on the
                timeline. Full-frame sweep in Advanced searches more often and usually
                closes a gap like this.
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

          <MarkList
            marks={marks}
            selectedId={selectedMark}
            frameRate={frameRate}
            frameCount={frameCount}
            onSelect={setSelectedMark}
            onSeek={seekToFrame}
            onChange={(next) =>
              setMarks((current) => current.map((mark) => (mark.id === next.id ? next : mark)))
            }
            onRemove={(id) => {
              setMarks((current) => current.filter((mark) => mark.id !== id))
              setSelectedMark((current) => (current === id ? null : current))
            }}
            onClear={() => {
              setMarks([])
              setSelectedMark(null)
            }}
            disabled={busy}
          />

          {busy && job.progress && <LiveMeters progress={job.progress} />}

          {!busy && job.info && job.estimate && (
            <Preflight info={job.info} estimate={job.estimate} />
          )}

          <AdvancedDrawer options={options} onChange={setOptions} disabled={busy} />
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-sidebar px-4 py-2.5">
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
              onClick={() => {
                // Starting a run ends marking: what happens next is something to
                // look at, and the comparison views are what it is for.
                setMarking(false)
                onStart(marks.length > 0 ? { ...options, manualMarks: marks } : options)
              }}
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
