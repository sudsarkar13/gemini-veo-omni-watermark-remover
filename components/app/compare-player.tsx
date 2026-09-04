"use client"

import { Pause, Play, SkipBack, SkipForward } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { ClipMedia } from "@gvowr/ipc"

import { Button } from "@/components/ui/button"
import { formatTimecode } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * Before/after video comparison.
 *
 * Chromium decodes the files itself, so both sides are ordinary video elements
 * pointed at the media protocol. No frames cross IPC.
 *
 * The original drives playback and the cleaned copy follows it. Two elements playing
 * independently drift apart within seconds, which would make any comparison
 * meaningless — so the second is corrected whenever it strays beyond a frame or so.
 */

export type CompareMode = "split" | "side" | "before" | "after"

const SYNC_TOLERANCE_SECONDS = 0.08

/** Labels written out rather than derived, so casing does not depend on a CSS variant. */
const COMPARE_MODES: readonly { value: CompareMode; label: string }[] = [
  { value: "split", label: "Split" },
  { value: "side", label: "Side by side" },
  { value: "before", label: "Before" },
  { value: "after", label: "After" },
]

export function ComparePlayer({
  className,
  media,
  frameRate,
  currentTime,
  onTimeChange,
  onDurationChange,
}: {
  className?: string
  media: ClipMedia
  frameRate: number
  currentTime: number
  onTimeChange: (seconds: number) => void
  onDurationChange: (seconds: number) => void
}) {
  const beforeRef = useRef<HTMLVideoElement>(null)
  const afterRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const hasAfter = media.outputUrl !== null
  const [playing, setPlaying] = useState(false)
  const [split, setSplit] = useState(0.5)

  // The chosen mode is stored only once the user picks one. Until then it is derived,
  // so it becomes the split comparison the moment there is something to compare with
  // — without an effect that would re-render the players a second time.
  const [chosenMode, setChosenMode] = useState<CompareMode | null>(null)
  const mode: CompareMode = chosenMode ?? (hasAfter ? "split" : "before")
  const setMode = setChosenMode

  const syncAfter = useCallback(() => {
    const before = beforeRef.current
    const after = afterRef.current
    if (!before || !after) return
    if (Math.abs(after.currentTime - before.currentTime) > SYNC_TOLERANCE_SECONDS) {
      after.currentTime = before.currentTime
    }
  }, [])

  // Seeks originate outside this component (timeline clicks, frame stepping), so the
  // elements follow the incoming time rather than owning it.
  useEffect(() => {
    const before = beforeRef.current
    if (!before) return
    if (Math.abs(before.currentTime - currentTime) > SYNC_TOLERANCE_SECONDS) {
      before.currentTime = currentTime
      syncAfter()
    }
  }, [currentTime, syncAfter])

  const toggle = useCallback(() => {
    const before = beforeRef.current
    const after = afterRef.current
    if (!before) return
    if (before.paused) {
      void before.play()
      if (after) void after.play()
      setPlaying(true)
    } else {
      before.pause()
      after?.pause()
      setPlaying(false)
    }
  }, [])

  const step = useCallback(
    (frames: number) => {
      const before = beforeRef.current
      if (!before) return
      before.pause()
      afterRef.current?.pause()
      setPlaying(false)
      const delta = frames / (frameRate > 0 ? frameRate : 30)
      const next = Math.max(0, Math.min(before.duration || 0, before.currentTime + delta))
      before.currentTime = next
      onTimeChange(next)
      syncAfter()
    },
    [frameRate, onTimeChange, syncAfter]
  )

  const onSplitDrag = useCallback((event: React.MouseEvent | React.TouchEvent) => {
    const container = containerRef.current
    if (!container) return
    const bounds = container.getBoundingClientRect()
    const clientX = "touches" in event ? event.touches[0]?.clientX : event.clientX
    if (clientX === undefined) return
    setSplit(Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)))
  }, [])

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/*
       * The monitor takes the height it is given and derives its width from the clip's
       * aspect ratio, so the picture box tracks the real frame rather than the pane.
       * That keeps the split divider over actual video instead of over letterboxing —
       * a divider that drifts onto a black bar makes the comparison hard to read.
       */}
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div
          ref={containerRef}
          className="relative h-full max-w-full overflow-hidden rounded-md border border-border bg-black"
          style={{ aspectRatio: media.aspectRatio }}
          onMouseMove={(event) => {
            if (mode === "split" && event.buttons === 1) onSplitDrag(event)
          }}
        >
          {mode === "side" && hasAfter ? (
            <div className="grid h-full grid-cols-2 gap-px">
              <Layer label="Original">
                <video
                  ref={beforeRef}
                  src={media.sourceUrl}
                  className="size-full object-contain"
                  onTimeUpdate={(event) => {
                    onTimeChange(event.currentTarget.currentTime)
                    syncAfter()
                  }}
                  onLoadedMetadata={(event) => onDurationChange(event.currentTarget.duration)}
                  onEnded={() => setPlaying(false)}
                />
              </Layer>
              <Layer label="Cleaned">
                <video ref={afterRef} src={media.outputUrl ?? undefined} muted className="size-full object-contain" />
              </Layer>
            </div>
          ) : (
            <>
              <video
                ref={beforeRef}
                src={media.sourceUrl}
                className={cn(
                  "absolute inset-0 size-full object-contain",
                  mode === "after" && hasAfter && "invisible"
                )}
                onTimeUpdate={(event) => {
                  onTimeChange(event.currentTarget.currentTime)
                  syncAfter()
                }}
                onLoadedMetadata={(event) => onDurationChange(event.currentTarget.duration)}
                onEnded={() => setPlaying(false)}
              />

              {hasAfter && (
                <video
                  ref={afterRef}
                  src={media.outputUrl ?? undefined}
                  muted
                  className="absolute inset-0 size-full object-contain"
                  style={
                    mode === "split"
                      ? { clipPath: `inset(0 0 0 ${split * 100}%)` }
                      : mode === "after"
                        ? undefined
                        : { display: "none" }
                  }
                />
              )}

              {mode === "split" && hasAfter && (
                <>
                  <div
                    className="absolute inset-y-0 z-10 w-px bg-primary"
                    style={{ left: `${split * 100}%` }}
                  />
                  <div
                    role="slider"
                    aria-label="Comparison position"
                    aria-valuenow={Math.round(split * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    tabIndex={0}
                    className="absolute inset-y-0 z-10 w-6 -translate-x-1/2 cursor-ew-resize"
                    style={{ left: `${split * 100}%` }}
                    onMouseDown={onSplitDrag}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowLeft") setSplit((v) => Math.max(0, v - 0.02))
                      if (event.key === "ArrowRight") setSplit((v) => Math.min(1, v + 0.02))
                    }}
                  />
                  <Corner className="left-2">Original</Corner>
                  <Corner className="right-2">Cleaned</Corner>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="icon" className="size-8" aria-label="Previous frame" onClick={() => step(-1)}>
          <SkipBack className="size-4" />
        </Button>
        <Button variant="secondary" size="icon" className="size-8" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Next frame" onClick={() => step(1)}>
          <SkipForward className="size-4" />
        </Button>

        <span className="ml-1 text-[11px] text-muted-foreground tabular">
          {formatTimecode(currentTime)}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {COMPARE_MODES.map(({ value, label }) => (
            <Button
              key={value}
              variant={mode === value ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={!hasAfter && value !== "before"}
              onClick={() => setMode(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {!hasAfter && (
        <p className="shrink-0 text-[11px] text-muted-foreground">
          Showing the original. Run the removal to compare it against the cleaned version.
        </p>
      )}
    </div>
  )
}

function Layer({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative size-full bg-black">
      {children}
      <Corner className="left-2">{label}</Corner>
    </div>
  )
}

function Corner({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute top-2 z-10 rounded bg-black/70 px-1.5 py-0.5",
        "text-[10px] font-medium uppercase tracking-wide text-white/90",
        className
      )}
    >
      {children}
    </span>
  )
}
