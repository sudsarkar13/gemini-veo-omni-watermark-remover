"use client"

import { Pause, Play, SkipBack, SkipForward, SquareDashed } from "lucide-react"
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
  overlay,
  marking,
  onMarkingChange,
  canMark,
}: {
  className?: string
  media: ClipMedia
  frameRate: number
  currentTime: number
  onTimeChange: (seconds: number) => void
  onDurationChange: (seconds: number) => void
  /** Drawing surface laid over the picture, sized to it exactly. */
  overlay?: React.ReactNode
  marking: boolean
  onMarkingChange: (marking: boolean) => void
  canMark: boolean
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
  // Marking always shows the original. Pointing at a mark on the cleaned copy would
  // mean drawing over the very thing that is supposed to be gone.
  const mode: CompareMode = marking ? "before" : (chosenMode ?? (hasAfter ? "split" : "before"))
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

  /**
   * Both players stay mounted in every mode and are only re-positioned.
   *
   * Rendering a different tree per mode remounts the video elements, which reloads
   * them and drops the playhead back to zero — switching from split to side-by-side
   * would throw away the exact frame you were inspecting. Side-by-side gives each
   * element half the box and lets `object-contain` fit the picture inside it, so the
   * geometry changes without the elements ever going away.
   */
  /**
   * Side by side needs a box twice as wide, not two videos crammed into one.
   *
   * The box used to keep the clip's own aspect ratio in every mode, so each half was
   * 8:9 and a 16:9 picture letterboxed into it — half the box left as black while the
   * pane either side of the box went unused. Doubling the ratio for this mode lets
   * each half be exactly one frame, and the box then claims the horizontal room it
   * needs to do it.
   */
  const boxAspect = mode === "side" && hasAfter ? media.aspectRatio * 2 : media.aspectRatio

  const geometry: { before: React.CSSProperties; after: React.CSSProperties } =
    mode === "side" && hasAfter
      ? { before: { left: 0, width: "50%" }, after: { left: "50%", width: "50%" } }
      : {
          before: { left: 0, width: "100%" },
          after:
            mode === "split"
              ? { left: 0, width: "100%", clipPath: `inset(0 0 0 ${split * 100}%)` }
              : mode === "after"
                ? { left: 0, width: "100%" }
                : { display: "none" },
        }

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
       * The monitor is fitted to the pane rather than merely bounded by it.
       *
       * `height: 100%` alone only works when the pane is the taller constraint; when
       * it is the wider one the height stays put and the aspect ratio silently breaks,
       * which is what left a 32:9 side-by-side box shaped like 16:9. Taking the
       * smaller of the two candidate heights — the pane's, and the one the pane's own
       * width implies — fits the box under either constraint, so it always tracks the
       * real frame and the split divider stays over actual video instead of drifting
       * onto a black bar.
       */}
      <div
        className="flex min-h-0 flex-1 items-center justify-center"
        style={{ containerType: "inline-size" }}
      >
        <div
          ref={containerRef}
          className="relative overflow-hidden rounded-md border border-border bg-black"
          style={{
            aspectRatio: boxAspect,
            height: `min(100%, calc(100cqw / ${boxAspect}))`,
          }}
          onMouseMove={(event) => {
            if (mode === "split" && event.buttons === 1) onSplitDrag(event)
          }}
        >
            <video
            ref={beforeRef}
            src={media.sourceUrl}
            className={cn(
              "absolute inset-y-0 object-contain",
              mode === "after" && hasAfter && "invisible"
            )}
            style={geometry.before}
            onTimeUpdate={(event) => {
              onTimeChange(event.currentTarget.currentTime)
              syncAfter()
            }}
            onLoadedMetadata={(event) => {
              onDurationChange(event.currentTarget.duration)
              // A finished run swaps in new media, which reloads the element and drops
              // the playhead to zero. Restoring it keeps the frame under inspection
              // under inspection.
              if (currentTime > 0) event.currentTarget.currentTime = currentTime
            }}
            onEnded={() => setPlaying(false)}
          />

          {hasAfter && (
            <video
              ref={afterRef}
              src={media.outputUrl ?? undefined}
              muted
              className="absolute inset-y-0 object-contain"
              style={geometry.after}
            />
          )}

          {mode === "split" && hasAfter && (
            <div
              role="slider"
              aria-label="Comparison position"
              aria-valuenow={Math.round(split * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              tabIndex={0}
              className="absolute inset-y-0 z-10 w-6 -translate-x-1/2 cursor-ew-resize border-l border-primary"
              style={{ left: `${split * 100}%` }}
              onMouseDown={onSplitDrag}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") setSplit((v) => Math.max(0, v - 0.02))
                if (event.key === "ArrowRight") setSplit((v) => Math.min(1, v + 0.02))
              }}
            />
          )}

          {overlay}

          {mode === "side" && hasAfter && (
            // The two halves butt together, so on similar frames — which is the whole
            // point of the comparison — the seam is invisible without this.
            <div aria-hidden className="absolute inset-y-0 left-1/2 z-10 w-px bg-border" />
          )}

          {hasAfter && (mode === "split" || mode === "side") && (
            <>
              <Corner className="left-2">Original</Corner>
              <Corner className={mode === "side" ? "left-[calc(50%+0.5rem)]" : "right-2"}>
                Cleaned
              </Corner>
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

        {canMark && (
          <Button
            variant={marking ? "default" : "ghost"}
            size="sm"
            className="ml-2 h-7 gap-1.5 px-2 text-[11px]"
            aria-pressed={marking}
            onClick={() => onMarkingChange(!marking)}
          >
            <SquareDashed className="size-3.5" />
            Mark
          </Button>
        )}

        <div className="ml-auto flex items-center gap-1">
          {COMPARE_MODES.map(({ value, label }) => (
            <Button
              key={value}
              variant={mode === value ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={marking || (!hasAfter && value !== "before")}
              onClick={() => setMode(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {marking ? (
        <p className="shrink-0 text-[11px] text-muted-foreground">
          Drag on the picture to draw a box over a watermark the detector missed. It
          applies from this frame to the end of the clip unless you narrow the range.
        </p>
      ) : (
        !hasAfter && (
          <p className="shrink-0 text-[11px] text-muted-foreground">
            Showing the original. Run the removal to compare it against the cleaned version.
          </p>
        )
      )}
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
