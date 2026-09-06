"use client"

import { Maximize, Minus, Pause, Play, Plus, SkipBack, SkipForward, SquareDashed } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ClipMedia, MediaKind } from "@gvowr/ipc"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
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

/**
 * Zoom, in screen pixels per source pixel.
 *
 * The ceiling is 8× actual pixels, per UI-SPEC §5.2. Beyond that a single source pixel
 * is a large square of flat colour and nothing further is learned about the removal —
 * the point of zooming here is to judge residue, not to admire interpolation.
 *
 * The floor is "fit", not a fixed percentage: zooming out past the pane would put the
 * picture in a letterbox inside a letterbox, and there is nothing out there to see.
 */
const MAX_DISPLAY_SCALE = 8
/** One notch of a mouse wheel is ~100 deltaY; this makes that about a 12% change. */
const WHEEL_SENSITIVITY = 0.0011
/** Step for the +/− buttons. Coarse enough to cross the range in a few presses. */
const BUTTON_STEP = 1.5

interface View {
  /** Content scale relative to fit. 1 is fit; never below it. */
  readonly zoom: number
  /** Pan as a fraction of the picture's fitted size, from centre. */
  readonly x: number
  readonly y: number
}

const FIT: View = { zoom: 1, x: 0, y: 0 }

/**
 * Pan is bounded so the edge of the picture never comes inside the frame.
 *
 * At zoom `z` the content is `z` times the box, so its centre may sit at most
 * `(z - 1) / 2` box-widths off centre before black appears at the opposite edge.
 * Clamping here rather than at the drag site means every path into a new view —
 * wheel, buttons, slider, drag — is bounded by construction.
 */
function clampPan(zoom: number, x: number, y: number): View {
  const limit = Math.max(0, (zoom - 1) / 2)
  return {
    zoom,
    x: Math.max(-limit, Math.min(limit, x)),
    y: Math.max(-limit, Math.min(limit, y)),
  }
}

/**
 * Change zoom while holding one point of the picture still under the cursor.
 *
 * A point sitting at content-fraction `p` from the centre appears at `pan + p * zoom`.
 * Solving that for the pan that keeps a given screen position fixed gives the line
 * below — which is what makes wheel-zoom feel like it is pointing at something rather
 * than drifting away from it.
 */
function zoomAt(view: View, requested: number, screenX: number, screenY: number, maxZoom: number): View {
  const zoom = Math.max(1, Math.min(maxZoom, requested))
  if (zoom === view.zoom) return view
  const ratio = zoom / view.zoom
  return clampPan(
    zoom,
    screenX - (screenX - view.x) * ratio,
    screenY - (screenY - view.y) * ratio
  )
}

export function ComparePlayer({
  className,
  media,
  kind,
  frameRate,
  frameWidth,
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
  /** A still has no transport: nothing to play, one frame to step through. */
  kind: MediaKind
  frameRate: number
  /** Source width in pixels, so "100%" can mean one screen pixel per source pixel. */
  frameWidth: number
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
  const layerRef = useRef<HTMLDivElement>(null)

  const hasAfter = media.outputUrl !== null
  const still = kind === "image"
  const [playing, setPlaying] = useState(false)
  const [split, setSplit] = useState(0.5)
  const [view, setView] = useState<View>(FIT)
  const [layerWidth, setLayerWidth] = useState(0)

  // The chosen mode is stored only once the user picks one. Until then it is derived,
  // so it becomes the split comparison the moment there is something to compare with
  // — without an effect that would re-render the players a second time.
  const [chosenMode, setChosenMode] = useState<CompareMode | null>(null)
  // Marking always shows the original. Pointing at a mark on the cleaned copy would
  // mean drawing over the very thing that is supposed to be gone.
  //
  // Choosing a comparison leaves Mark mode rather than being refused by it. Locking
  // the modes out while marking meant that after a run — with Mark mode still on from
  // before it — the whole point of the run could not be looked at.
  const mode: CompareMode = marking ? "before" : (chosenMode ?? (hasAfter ? "split" : "before"))
  const setMode = setChosenMode

  /**
   * Zoom is stored relative to fit, but presented as a percentage of actual pixels.
   *
   * Those are different numbers and only the second one means anything: "160%" says a
   * source pixel covers a bit more than one and a half screen pixels, which is what
   * you need to know when judging whether a residue is real or a display artefact.
   * Fit is whatever the pane happens to allow, and changes when the window resizes.
   */
  const fitScale = layerWidth > 0 && frameWidth > 0 ? layerWidth / frameWidth : 0
  const maxZoom = fitScale > 0 ? Math.max(1, MAX_DISPLAY_SCALE / fitScale) : 1
  const displayPercent = fitScale > 0 ? Math.round(fitScale * view.zoom * 100) : 0
  const fitPercent = fitScale > 0 ? Math.round(fitScale * 100) : 0
  const zoomed = view.zoom > 1.001

  // Read by the wheel listener, which is attached once and must not close over a
  // stale ceiling — the pane is resizable, so the ceiling moves.
  const maxZoomRef = useRef(maxZoom)
  useEffect(() => {
    maxZoomRef.current = maxZoom
  }, [maxZoom])

  useLayoutEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setLayerWidth(entry.contentRect.width)
    })
    observer.observe(layer)
    setLayerWidth(layer.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [])

  // Wheel zoom is attached by hand because React's own wheel listener is passive:
  // preventDefault through onWheel is ignored, and the whole pane scrolls instead.
  useEffect(() => {
    const box = containerRef.current
    if (!box) return
    const onWheel = (event: WheelEvent) => {
      const layer = layerRef.current
      if (!layer || event.deltaY === 0) return
      event.preventDefault()
      const bounds = layer.getBoundingClientRect()
      if (bounds.width === 0 || bounds.height === 0) return
      const screenX = (event.clientX - bounds.left) / bounds.width - 0.5
      const screenY = (event.clientY - bounds.top) / bounds.height - 0.5
      setView((prev) =>
        zoomAt(
          prev,
          prev.zoom * Math.exp(-event.deltaY * WHEEL_SENSITIVITY),
          screenX,
          screenY,
          maxZoomRef.current
        )
      )
    }
    box.addEventListener("wheel", onWheel, { passive: false })
    return () => box.removeEventListener("wheel", onWheel)
  }, [])

  // Fit and 100%, per UI-SPEC §9. Bound on the window rather than the element because
  // the picture is not a focusable control and should not become one.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return
      }
      if (event.key === "0") setView(FIT)
      if (event.key === "1") {
        setView((prev) => zoomAt(prev, 1 / (fitScale || 1), 0, 0, maxZoomRef.current))
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [fitScale])

  const setZoom = useCallback((requested: number) => {
    setView((prev) => zoomAt(prev, requested, 0, 0, maxZoomRef.current))
  }, [])

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

  /**
   * Zoom scales the picture inside each half, not the layout around it.
   *
   * The split divider, the seam and the corner labels are positioned in the box's own
   * coordinates and stay out of the transform: a divider that zoomed with the picture
   * would slide off the seam it names. Both halves carry the identical transform, so
   * the two pictures stay registered pixel for pixel however far in you go — which is
   * the only reason zooming a comparison is worth anything.
   */
  const stageStyle: React.CSSProperties = {
    transform: `translate(${view.x * 100}%, ${view.y * 100}%) scale(${view.zoom})`,
    // Nearest-neighbour past actual size: an interpolated pixel is an invented one,
    // and this view exists to judge whether pixels are right.
    imageRendering: displayPercent > 100 ? "pixelated" : "auto",
  }

  const onSplitDrag = useCallback((event: React.MouseEvent | React.TouchEvent) => {
    const container = containerRef.current
    if (!container) return
    const bounds = container.getBoundingClientRect()
    const clientX = "touches" in event ? event.touches[0]?.clientX : event.clientX
    if (clientX === undefined) return
    setSplit(Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)))
  }, [])

  /**
   * Panning is a drag, but only where a drag means nothing else.
   *
   * Middle-drag always pans. Left-drag pans only when zoomed and neither the split
   * divider nor Mark mode has a claim on it — both of those are also left-drags on the
   * same pixels, and a gesture that does two things does neither reliably.
   */
  const pan = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const [panning, setPanning] = useState(false)
  const canLeftPan = zoomed && !marking && mode !== "split"

  const onPointerDown = (event: React.PointerEvent) => {
    const middle = event.button === 1
    if (!middle && !(event.button === 0 && canLeftPan)) return
    if (!zoomed) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
    setPanning(true)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const active = pan.current
    const layer = layerRef.current
    if (!active || active.pointerId !== event.pointerId || !layer) return
    const bounds = layer.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0) return
    const dx = (event.clientX - active.x) / bounds.width
    const dy = (event.clientY - active.y) / bounds.height
    pan.current = { ...active, x: event.clientX, y: event.clientY }
    setView((prev) => clampPan(prev.zoom, prev.x + dx, prev.y + dy))
  }

  const endPan = () => {
    pan.current = null
    setPanning(false)
  }

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
          className={cn(
            "relative overflow-hidden rounded-md border border-border bg-black",
            zoomed && (panning ? "cursor-grabbing" : canLeftPan ? "cursor-grab" : null)
          )}
          style={{
            aspectRatio: boxAspect,
            height: `min(100%, calc(100cqw / ${boxAspect}))`,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onMouseMove={(event) => {
            if (mode === "split" && event.buttons === 1 && !pan.current) onSplitDrag(event)
          }}
        >
          <div
            ref={layerRef}
            className={cn(
              "absolute inset-y-0 overflow-hidden",
              mode === "after" && hasAfter && "invisible"
            )}
            style={geometry.before}
          >
            <div className="absolute inset-0" style={stageStyle}>
              {still ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={media.sourceUrl}
                  alt="Original"
                  draggable={false}
                  className="absolute inset-0 size-full object-contain"
                />
              ) : (
                <video
                  ref={beforeRef}
                  src={media.sourceUrl}
                  className="absolute inset-0 size-full object-contain"
                  onTimeUpdate={(event) => {
                    onTimeChange(event.currentTarget.currentTime)
                    syncAfter()
                  }}
                  onLoadedMetadata={(event) => {
                    onDurationChange(event.currentTarget.duration)
                    // A finished run swaps in new media, which reloads the element and
                    // drops the playhead to zero. Restoring it keeps the frame under
                    // inspection under inspection.
                    if (currentTime > 0) event.currentTarget.currentTime = currentTime
                  }}
                  onEnded={() => setPlaying(false)}
                />
              )}
              {/*
               * The overlay rides inside the transform, so a region drawn at 400% lands
               * on the frame pixels it was drawn over. It also lives in the *before*
               * half, which is what makes a marked region sit in the right place in
               * side-by-side rather than spanning both pictures.
               */}
              {overlay}
            </div>
          </div>

          {hasAfter && (
            <div className="absolute inset-y-0 overflow-hidden" style={geometry.after}>
              <div className="absolute inset-0" style={stageStyle}>
                {still ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={media.outputUrl ?? undefined}
                    alt="Cleaned"
                    draggable={false}
                    className="absolute inset-0 size-full object-contain"
                  />
                ) : (
                  <video
                    ref={afterRef}
                    src={media.outputUrl ?? undefined}
                    muted
                    className="absolute inset-0 size-full object-contain"
                  />
                )}
              </div>
            </div>
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

      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        {/* Absent rather than disabled on a still: there is nothing to play and one
            frame to step through, and a row of dead buttons is worse than no row. */}
        {!still && (
          <>
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
          </>
        )}

        {canMark && (
          <Button
            variant={marking ? "default" : "ghost"}
            size="sm"
            className="ml-1 h-7 gap-1.5 px-2 text-[11px]"
            aria-pressed={marking}
            onClick={() => onMarkingChange(!marking)}
          >
            <SquareDashed className="size-3.5" />
            Mark
          </Button>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Zoom out"
            disabled={!zoomed}
            onClick={() => setZoom(view.zoom / BUTTON_STEP)}
          >
            <Minus className="size-3.5" />
          </Button>
          <Slider
            className="w-20"
            aria-label="Zoom"
            min={Math.max(1, fitPercent)}
            max={Math.max(2, Math.round(MAX_DISPLAY_SCALE * 100))}
            step={1}
            value={[Math.max(fitPercent, displayPercent)]}
            disabled={fitScale <= 0}
            onValueChange={(value) => {
              const percent = Array.isArray(value) ? value[0] : value
              if (percent !== undefined && fitScale > 0) setZoom(percent / 100 / fitScale)
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Zoom in"
            disabled={fitScale <= 0 || view.zoom >= maxZoom - 0.001}
            onClick={() => setZoom(view.zoom * BUTTON_STEP)}
          >
            <Plus className="size-3.5" />
          </Button>
          <span className="w-10 text-right text-[11px] text-muted-foreground tabular">
            {displayPercent}%
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[11px]"
            aria-label="Zoom to fit"
            disabled={!zoomed}
            onClick={() => setView(FIT)}
          >
            <Maximize className="size-3.5" />
            Fit
          </Button>
        </div>

        <div className="flex items-center gap-1">
          {COMPARE_MODES.map(({ value, label }) => (
            <Button
              key={value}
              variant={mode === value ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={!hasAfter && value !== "before"}
              onClick={() => {
                if (marking) onMarkingChange(false)
                setMode(value)
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {marking ? (
        <p className="shrink-0 text-[11px] text-muted-foreground">
          Drag on the picture to draw a box over a watermark the detector missed.
          {still
            ? " Scroll to zoom in first if the mark is small."
            : " It applies from this frame to the end of the clip unless you narrow the range. Scroll to zoom in first if the mark is small."}
        </p>
      ) : zoomed ? (
        <p className="shrink-0 text-[11px] text-muted-foreground">
          Scroll to zoom at the pointer · drag to pan{mode === "split" ? " (middle button)" : ""} ·{" "}
          <kbd className="font-sans">0</kbd> fits, <kbd className="font-sans">1</kbd> is actual size.
        </p>
      ) : (
        !hasAfter && (
          <p className="shrink-0 text-[11px] text-muted-foreground">
            Showing the original. Run the removal to compare it against the cleaned{" "}
            {still ? "image" : "version"}.
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
