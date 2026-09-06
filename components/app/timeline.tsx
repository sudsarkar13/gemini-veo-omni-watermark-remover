"use client"

import { Maximize, Minus, Plus } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ClipMedia, FilmstripWindow, JobResult } from "@gvowr/ipc"

import { Button } from "@/components/ui/button"
import { useFilmstripWindow } from "@/hooks/use-desktop"
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
 *
 * Zooming shows a window of the clip rather than the whole of it. At fit, a ten-second
 * clip gives every frame about four pixels and a five-frame gap is a smear; the window
 * is what makes "frames 235–239" a thing you can actually point at. The playhead stays
 * centred while zoomed, so the window follows playback instead of the picture jumping
 * a screen at a time.
 */

/**
 * Tightest window, in seconds of video.
 *
 * A window under about half a second is all playhead and no context — and the strip
 * cannot resolve past one thumbnail per frame anyway.
 */
const MIN_WINDOW_SECONDS = 0.5
/** Roughly how many pixels of strip each thumbnail should occupy. */
const THUMBNAIL_PITCH = 84
/** Ceiling on how many thumbnails one window may ask for. Matches the main process. */
const MAX_WINDOW_THUMBNAILS = 60
const ZOOM_STEP = 1.6
/** One notch of a wheel is ~100 deltaY; this makes that about a 12% change. */
const WHEEL_SENSITIVITY = 0.0011

/** One picture of the strip, placed by the moment it represents. */
interface StripFrame {
  /** Position in the strip it came from. The React key: a window may sample the same
   * file twice near the end of a clip, and two children cannot share a key. */
  readonly index: number
  readonly src: string
  readonly from: number
  readonly to: number
}

export function Timeline({
  className,
  jobId,
  media,
  duration,
  currentTime,
  frameCount,
  onSeek,
  result,
  playing = false,
}: {
  className?: string
  /** Needed to ask for a denser strip over the visible window. */
  jobId: string
  media: ClipMedia
  duration: number
  currentTime: number
  /** Total frames in the clip, so detection ranges land where they actually are. */
  frameCount: number
  onSeek: (seconds: number) => void
  result: JobResult | null
  /**
   * True while the clip is playing.
   *
   * A zoomed window follows the playhead, so during playback its start crosses a
   * quantisation boundary every second or so — and each crossing would run FFmpeg
   * again in the main process. That work competes with decoding on the same machine
   * and is heard as audio breaking up before it is seen. The strip in hand is a
   * moment stale during playback, which nobody can see at twenty-four frames a
   * second, and it is refreshed as soon as the clip stops.
   */
  playing?: boolean
}) {
  const stripRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [stripWidth, setStripWidth] = useState(0)

  const clip = duration > 0 ? duration : 1
  const fps = frameCount > 0 && clip > 0 ? frameCount / clip : 0
  const maxZoom = Math.max(1, clip / MIN_WINDOW_SECONDS)
  const zoomed = zoom > 1.001

  /**
   * The visible window, centred on the playhead and clamped to the clip.
   *
   * Derived rather than stored: a stored window would need an effect to follow the
   * playhead, and the two would disagree for a frame every time either changed.
   */
  const span = Math.min(clip, clip / zoom)
  const from = Math.max(0, Math.min(currentTime - span / 2, clip - span))
  const to = from + span

  const percent = useCallback(
    (seconds: number): number => ((seconds - from) / span) * 100,
    [from, span]
  )
  /** Frame indices are placed through time, so a gap lands where it actually is. */
  const frameTime = useCallback(
    (frame: number): number => (frame / (frameCount > 0 ? frameCount : 1)) * clip,
    [frameCount, clip]
  )

  useLayoutEffect(() => {
    const element = stripRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setStripWidth(entry.contentRect.width)
    })
    observer.observe(element)
    setStripWidth(element.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [])

  /**
   * The window asked of the main process is wider than the one on screen, and its
   * start is quantised.
   *
   * Both for the same reason: the displayed window moves with every frame of playback,
   * and requesting exactly what is displayed would re-run FFmpeg continuously and
   * still arrive late. Asking for a quantised window twice the width means most
   * playhead movement is already covered by the strip in hand.
   */
  const step = span / 2
  const requestedFrom = zoomed ? Math.max(0, Math.floor((from - span / 2) / step) * step) : 0
  const requestedTo = zoomed ? Math.min(clip, requestedFrom + span * 2) : 0
  const requestedCount = Math.max(
    4,
    Math.min(MAX_WINDOW_THUMBNAILS, Math.round((stripWidth * 2) / THUMBNAIL_PITCH) || 4)
  )
  const dense = useFilmstripWindow(
    jobId,
    zoomed && stripWidth > 0 && !playing
      ? { fromSeconds: requestedFrom, toSeconds: requestedTo, count: requestedCount }
      : null
  )

  /**
   * Memoised, because this is rebuilt on every tick of playback otherwise.
   *
   * The playhead moves several times a second, and each move re-renders this
   * component. Without memoising, that re-diffs twenty-eight images and up to four
   * hundred waveform bars each time, for a picture that has not changed — work that
   * competes with video decoding for the same main thread and shows up as a stutter.
   * At fit these inputs are constant, so the strip is built once.
   */
  const frames = useMemo(
    () => visibleFrames(dense, media, clip, from, to),
    [dense, media, clip, from, to]
  )

  // Wheel zoom is attached by hand: React's wheel listener is passive, so
  // preventDefault through onWheel is ignored and the pane scrolls instead.
  useEffect(() => {
    const element = stripRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return
      event.preventDefault()
      setZoom((prev) =>
        Math.max(1, Math.min(maxZoom, prev * Math.exp(-event.deltaY * WHEEL_SENSITIVITY)))
      )
    }
    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [maxZoom])

  const seekFromEvent = useCallback(
    (event: React.MouseEvent) => {
      const element = stripRef.current
      if (!element || duration <= 0) return
      const bounds = element.getBoundingClientRect()
      const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
      onSeek(from + fraction * span)
    },
    [duration, from, span, onSeek]
  )

  const changeZoom = (factor: number): void =>
    setZoom((prev) => Math.max(1, Math.min(maxZoom, prev * factor)))

  const waveform = media.waveform ?? []
  const firstBar = Math.floor((from / clip) * waveform.length)
  const lastBar = Math.ceil((to / clip) * waveform.length)
  const bars = zoomed ? waveform.slice(firstBar, Math.max(firstBar + 1, lastBar)) : waveform

  const filmstrip = useMemo(
    () =>
      frames.map((frame) => (
        // Plain img: these are local media:// URLs, which next/image cannot optimise
        // and should not try to.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={frame.index}
          src={frame.src}
          alt=""
          draggable={false}
          className="absolute inset-y-0 h-full object-cover"
          style={{
            left: `${((frame.from - from) / span) * 100}%`,
            width: `${((frame.to - frame.from) / span) * 100}%`,
          }}
        />
      )),
    [frames, from, span]
  )

  const waveformBars = useMemo(
    () =>
      bars.map((amplitude, index) => (
        <div
          key={index}
          className="min-w-0 max-w-[6px] flex-1 rounded-[1px] bg-muted-foreground/50"
          style={{ height: `${Math.max(4, amplitude * 100)}%` }}
        />
      )),
    [bars]
  )

  return (
    <div
      className={cn(
        "relative select-none rounded-md border border-border bg-surface",
        className
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Timeline
        </span>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Zoom timeline out"
            disabled={!zoomed}
            onClick={() => changeZoom(1 / ZOOM_STEP)}
          >
            <Minus className="size-3" />
          </Button>
          {/*
            * Frames, not timecode, once zoomed.
            *
            * A window under a second reads as "0:09–0:09" in timecode — the same value
            * twice, for a range that is the whole point of having zoomed. Frame numbers
            * are also what the run reports its gaps in, so a window can be lined up
            * against "frames 235–239" directly.
            */}
          <span className="w-24 text-center text-[10px] text-muted-foreground tabular">
            {zoomed ? `frames ${Math.round(from * fps)}–${Math.round(to * fps)}` : "whole clip"}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Zoom timeline in"
            disabled={zoom >= maxZoom - 0.001}
            onClick={() => changeZoom(ZOOM_STEP)}
          >
            <Plus className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Fit timeline to clip"
            disabled={!zoomed}
            onClick={() => setZoom(1)}
          >
            <Maximize className="size-3" />
          </Button>
          <span className="ml-1 text-[10px] text-muted-foreground tabular">
            {formatTimecode(currentTime)} / {formatTimecode(duration)}
          </span>
        </div>
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
          // A step of one window-width per keypress would skip the detail the zoom was
          // for, so stepping follows the window: a second at fit, a frame or two in.
          const nudge = Math.max(1 / 60, span / 20)
          if (event.key === "ArrowLeft") onSeek(Math.max(0, currentTime - nudge))
          if (event.key === "ArrowRight") onSeek(Math.min(duration, currentTime + nudge))
          if (event.key === "+" || event.key === "=") changeZoom(ZOOM_STEP)
          if (event.key === "-") changeZoom(1 / ZOOM_STEP)
          if (event.key === "0") setZoom(1)
        }}
      >
        {frames.length > 0 ? (
          <div className="relative h-14 w-full overflow-hidden border-y border-border">
            {filmstrip}
          </div>
        ) : (
          <div className="flex h-14 items-center justify-center border-y border-border text-[11px] text-muted-foreground">
            No preview frames available
          </div>
        )}

        {/*
          * Bars are capped in width so a zoomed window reads as the sampled envelope it
          * is. The waveform has a fixed number of buckets for the whole clip, and
          * without a cap a half-second window stretches twenty of them into a wall of
          * grey that looks like data it does not have.
          */}
        {bars.length > 0 && (
          <div className="flex h-9 items-center justify-between gap-px overflow-hidden bg-background/60 px-px">
            {waveformBars}
          </div>
        )}

        {result && (
          <div className="relative h-2 w-full overflow-hidden bg-muted/40">
            {result.trackedFrom >= 0 && (
              <div
                className="absolute inset-y-0 bg-track-corner"
                style={{
                  left: `${percent(frameTime(result.trackedFrom))}%`,
                  width: `${((frameTime(result.trackedTo + 1) - frameTime(result.trackedFrom)) / span) * 100}%`,
                }}
                title={`Tracked across frames ${result.trackedFrom}–${result.trackedTo}`}
              />
            )}
            {result.uncoveredRanges.map((range) => (
              <div
                key={`${range.from}-${range.to}`}
                className="absolute inset-y-0 bg-warning"
                style={{
                  left: `${percent(frameTime(range.from))}%`,
                  width: `${Math.max(0.4, ((frameTime(range.to + 1) - frameTime(range.from)) / span) * 100)}%`,
                }}
                title={`Frames ${range.from}–${range.to} still carry the mark`}
              />
            ))}
          </div>
        )}

        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-primary shadow-[0_0_6px_var(--primary)]"
          style={{ left: `${percent(currentTime)}%` }}
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
          {result.framesUncovered > 0 && (
            <Legend className="bg-warning">Still marked {result.framesUncovered}</Legend>
          )}
          {/* Never added into "corrected": those frames have the pixels that were
              there, these have plausible ones. */}
          {result.framesFilled > 0 && (
            <Legend className="bg-track-roaming">Filled {result.framesFilled}</Legend>
          )}
          <span className="ml-auto">
            {result.tracksFound} watermark{result.tracksFound === 1 ? "" : "s"} tracked
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * The pictures to draw for the visible window, from whichever strip covers it.
 *
 * The dense strip is preferred but may lag a fast scrub by a moment, and it can be
 * missing entirely — a clip FFmpeg cannot sample twice is still a clip. Falling back
 * to the clip-wide strip stretches the pictures, which is worse than a dense strip and
 * far better than an empty band where the filmstrip used to be.
 */
function visibleFrames(
  dense: FilmstripWindow | null,
  media: ClipMedia,
  clip: number,
  from: number,
  to: number
): StripFrame[] {
  const source =
    dense && dense.interval > 0 && dense.fromSeconds <= from + dense.interval && dense.toSeconds >= to - dense.interval
      ? { thumbnails: dense.thumbnails, start: dense.fromSeconds, interval: dense.interval }
      : {
          thumbnails: media.thumbnails,
          start: 0,
          interval:
            media.thumbnailInterval > 0
              ? media.thumbnailInterval
              : clip / Math.max(1, media.thumbnails.length),
        }

  const frames: StripFrame[] = []
  for (const [index, src] of source.thumbnails.entries()) {
    const start = source.start + index * source.interval
    const end = start + source.interval
    if (end <= from || start >= to) continue
    frames.push({ index, src, from: start, to: end })
  }
  return frames
}

function Legend({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-2 rounded-[2px]", className)} aria-hidden />
      {children}
    </span>
  )
}
