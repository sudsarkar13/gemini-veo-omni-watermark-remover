"use client"

import { useCallback, useRef } from "react"
import type { ClipMedia, JobResult } from "@gvowr/ipc"

import { formatTimecode } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * The clip timeline: a filmstrip, an audio waveform, and the detection track.
 *
 * Thumbnails rather than a bare scrub bar, because finding the moment you care about
 * by eye is the whole point. The waveform sits beneath them since speech and silence
 * locate a moment faster than images alone — audio is stream-copied untouched, so it
 * is shown for orientation, not for editing.
 *
 * The detection lane is the visible form of what the engine actually models: a set of
 * tracks through time rather than one fixed rectangle. Frames deliberately left
 * untouched are drawn distinctly instead of being folded into a clean-looking whole.
 */
export function Timeline({
  className,
  media,
  duration,
  currentTime,
  onSeek,
  result,
}: {
  className?: string
  media: ClipMedia
  duration: number
  currentTime: number
  onSeek: (seconds: number) => void
  result: JobResult | null
}) {
  const stripRef = useRef<HTMLDivElement>(null)

  const seekFromEvent = useCallback(
    (event: React.MouseEvent) => {
      const element = stripRef.current
      if (!element || duration <= 0) return
      const bounds = element.getBoundingClientRect()
      const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
      onSeek(fraction * duration)
    },
    [duration, onSeek]
  )

  const playheadPercent = duration > 0 ? (currentTime / duration) * 100 : 0
  const totalFrames = result ? result.framesCorrected + result.framesLeftUntouched : 0
  const skippedFraction = totalFrames > 0 ? result!.framesLeftUntouched / totalFrames : 0

  return (
    <div
      className={cn(
        "relative select-none rounded-md border border-border bg-surface",
        className
      )}
    >
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Timeline
        </span>
        <span className="text-[10px] text-muted-foreground tabular">
          {formatTimecode(currentTime)} / {formatTimecode(duration)}
        </span>
      </div>

      <div
        ref={stripRef}
        className="relative cursor-pointer"
        onClick={seekFromEvent}
        onMouseMove={(event) => {
          if (event.buttons === 1) seekFromEvent(event)
        }}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") onSeek(Math.max(0, currentTime - 1))
          if (event.key === "ArrowRight") onSeek(Math.min(duration, currentTime + 1))
        }}
      >
        {media.thumbnails.length > 0 ? (
          <div className="flex h-14 w-full overflow-hidden border-y border-border">
            {media.thumbnails.map((src, index) => (
              // Plain img: these are local media:// URLs, which next/image cannot
              // optimise and should not try to.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={src}
                src={src}
                alt=""
                draggable={false}
                className="h-full min-w-0 flex-1 object-cover"
                style={{ opacity: index === 0 ? 1 : undefined }}
              />
            ))}
          </div>
        ) : (
          <div className="flex h-14 items-center justify-center border-y border-border text-[11px] text-muted-foreground">
            No preview frames available
          </div>
        )}

        {media.waveform && media.waveform.length > 0 && (
          <div className="flex h-9 items-center gap-px overflow-hidden bg-background/60 px-px">
            {media.waveform.map((amplitude, index) => (
              <div
                key={index}
                className="min-w-0 flex-1 rounded-[1px] bg-muted-foreground/50"
                style={{ height: `${Math.max(4, amplitude * 100)}%` }}
              />
            ))}
          </div>
        )}

        {result && (
          <div className="flex h-2 w-full overflow-hidden">
            <div
              className="bg-track-corner"
              style={{ width: `${(1 - skippedFraction) * 100}%` }}
              title={`${result.framesCorrected} frames corrected`}
            />
            <div
              className="bg-track-occluded"
              style={{ width: `${skippedFraction * 100}%` }}
              title={`${result.framesLeftUntouched} frames left untouched`}
            />
          </div>
        )}

        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-primary shadow-[0_0_6px_var(--primary)]"
          style={{ left: `${playheadPercent}%` }}
        />
      </div>

      {result && (
        <div className="flex items-center gap-4 px-3 py-1.5 text-[10px] text-muted-foreground">
          <Legend className="bg-track-corner">Corrected {result.framesCorrected}</Legend>
          {result.framesLeftUntouched > 0 && (
            <Legend className="bg-track-occluded">
              Left untouched {result.framesLeftUntouched}
            </Legend>
          )}
          <span className="ml-auto">
            {result.tracksFound} watermark{result.tracksFound === 1 ? "" : "s"} tracked
          </span>
        </div>
      )}
    </div>
  )
}

function Legend({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-2 rounded-[2px]", className)} aria-hidden />
      {children}
    </span>
  )
}
