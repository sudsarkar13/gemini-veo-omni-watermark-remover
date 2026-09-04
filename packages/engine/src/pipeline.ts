import { scaleAlphaMap } from "./alpha-map.ts"
import { unblend } from "./blend.ts"
import { toGrayscale } from "./correlate.ts"
import {
  analyseFrame,
  defaultSizes,
  overlap,
  searchWindow,
  sizeTemplate,
  sweepFrame,
  type Candidate,
  type SearchOptions,
  type SizedTemplate,
} from "./detect.ts"
import { cornerCandidates, hasCalibratedProfile } from "./geometry.ts"
import { buildTracks, type Observation, type TrackOptions } from "./track.ts"
import type { AlphaMap, Frame, Rect, WatermarkTrack } from "./types.ts"
import { verifyReversibility, type VerifyOptions } from "./verify.ts"

/**
 * Clip-level orchestration: the two passes described in docs/PLAN.md §5.
 *
 * Pass 1 walks every frame, predicting where known marks moved to and periodically
 * sweeping the whole frame for new ones. Pass 2 consolidates the finished timeline.
 * Rendering is separate and happens afterwards, because the correction applied to any
 * given frame depends on evidence from frames after it.
 */

export type DetectionMode = "auto" | "corner" | "sweep"

export interface PlanOptions extends SearchOptions, TrackOptions, VerifyOptions {
  /**
   * Frames between full-frame sweeps. Tracking between sweeps is nearly free; the
   * sweep is what finds marks that appear part-way through, so this trades detection
   * latency for throughput.
   */
  readonly sweepInterval?: number
  /** Half-width of the local search window used to follow an established track. */
  readonly trackRadius?: number
  /**
   * corner: only ever look at the calibrated corner, like existing tools. Fast, and
   *         blind to anything elsewhere in the frame.
   * sweep:  search the whole frame on the sweep interval.
   * auto:   sweep, but seed from the corner priors.
   */
  readonly mode?: DetectionMode
}

export interface FrameReport {
  readonly index: number
  readonly candidates: number
  readonly verified: number
  readonly sweep: boolean
}

export interface ClipDiagnostics {
  readonly width: number
  readonly height: number
  readonly frameCount: number
  /** False for 4K, 1:1 and 9:16 today — a known gap, surfaced rather than hidden. */
  readonly calibratedResolution: boolean
  readonly mode: DetectionMode
  readonly sweeps: number
  readonly tracksRejected: number
  readonly framesDetected: number
  readonly framesInterpolated: number
  readonly framesOccluded: number
  readonly elapsedMs: number
  readonly frames: FrameReport[]
}

export interface ClipPlan {
  readonly tracks: WatermarkTrack[]
  readonly diagnostics: ClipDiagnostics
}

const DEFAULT_SWEEP_INTERVAL = 15
const DEFAULT_TRACK_RADIUS = 8

/**
 * Pass 0 and 1: analyse every frame and follow marks through the clip.
 *
 * Takes an iterable of frames rather than a file so the engine stays free of I/O.
 * Phase 2 feeds this from an FFmpeg pipe; the tests feed it synthetic frames.
 */
export function planClip(frames: Iterable<Frame>, map: AlphaMap, options: PlanOptions = {}): ClipPlan {
  const mode = options.mode ?? "auto"
  const sweepInterval = options.sweepInterval ?? DEFAULT_SWEEP_INTERVAL
  const trackRadius = options.trackRadius ?? DEFAULT_TRACK_RADIUS

  const started = Date.now()
  const perFrame: Observation[][] = []
  const reports: FrameReport[] = []

  let width = 0
  let height = 0
  let sweeps = 0
  let index = 0
  let previous: Rect[] = []
  let templates: SizedTemplate[] | null = null

  for (const frame of frames) {
    if (index === 0) {
      width = frame.width
      height = frame.height
      templates = (options.sizes ?? defaultSizes(width, height)).map((size) =>
        sizeTemplate(map, size)
      )
    }

    const analysis = analyseFrame(toGrayscale(frame))
    const shouldSweep =
      mode !== "corner" && (previous.length === 0 || index % sweepInterval === 0)
    if (shouldSweep) sweeps++

    const candidates = collectCandidates(
      analysis,
      map,
      templates as SizedTemplate[],
      previous,
      { shouldSweep, mode, trackRadius, width, height },
      options
    )

    const observations: Observation[] = []
    for (const candidate of candidates) {
      const scaled = scaleAlphaMap(map, candidate.rect.width, candidate.rect.height)
      const verdict = verifyReversibility(analysis.image, scaled, candidate.rect, options)
      // The verifier is the gate, not the detector. Correlation cannot tell a mark
      // from a highlight; reversibility can.
      if (!verdict.isComposite) continue
      observations.push({
        rect: candidate.rect,
        alpha: verdict.gain,
        confidence: candidate.score,
      })
    }

    perFrame.push(observations)
    previous = observations.map((o) => o.rect)
    reports.push({
      index,
      candidates: candidates.length,
      verified: observations.length,
      sweep: shouldSweep,
    })
    index++
  }

  const { tracks, rejected } = buildTracks(perFrame, options)

  let detected = 0
  let interpolated = 0
  let occluded = 0
  for (const track of tracks) {
    for (const frame of track.frames.values()) {
      if (frame.state === "detected") detected++
      else if (frame.state === "interpolated") interpolated++
      else occluded++
    }
  }

  return {
    tracks,
    diagnostics: {
      width,
      height,
      frameCount: index,
      calibratedResolution: width > 0 && hasCalibratedProfile(width, height),
      mode,
      sweeps,
      tracksRejected: rejected,
      framesDetected: detected,
      framesInterpolated: interpolated,
      framesOccluded: occluded,
      elapsedMs: Date.now() - started,
      frames: reports,
    },
  }
}

interface CollectContext {
  readonly shouldSweep: boolean
  readonly mode: DetectionMode
  readonly trackRadius: number
  readonly width: number
  readonly height: number
}

/**
 * Proposes candidate regions for one frame: follow what we already know about first,
 * then sweep for anything new. Following is a tiny local search, which is why
 * tracking costs almost nothing next to sweeping.
 */
function collectCandidates(
  analysis: ReturnType<typeof analyseFrame>,
  map: AlphaMap,
  templates: readonly SizedTemplate[],
  previous: readonly Rect[],
  context: CollectContext,
  options: SearchOptions
): Candidate[] {
  const found: Candidate[] = []

  for (const rect of previous) {
    const best = searchWindow(
      analysis,
      templates,
      {
        x: rect.x - context.trackRadius,
        y: rect.y - context.trackRadius,
        width: context.trackRadius * 2,
        height: context.trackRadius * 2,
      },
      options
    )
    if (best) found.push(best)
  }

  if (context.mode === "corner" && found.length === 0) {
    for (const candidate of cornerCandidates(context.width, context.height)) {
      const best = searchWindow(
        analysis,
        templates,
        {
          x: candidate.rect.x - context.trackRadius,
          y: candidate.rect.y - context.trackRadius,
          width: context.trackRadius * 2,
          height: context.trackRadius * 2,
        },
        options
      )
      if (best) found.push(best)
    }
  }

  if (context.shouldSweep) {
    for (const candidate of sweepFrame(analysis, map, options)) {
      // Do not re-propose something we are already following.
      if (found.every((f) => overlap(f.rect, candidate.rect) <= 0.3)) found.push(candidate)
    }
  }

  return found
}

export interface RenderReport {
  readonly applied: number
  readonly skipped: number
}

/**
 * Pass 3: apply the plan to one frame, mutating it in place.
 *
 * Occluded frames are deliberately left alone. Leaving a mark visible on a handful of
 * frames is honest; correcting pixels we could not locate would smear the error
 * across the wrong part of the image, which is worse and much harder to notice.
 */
export function renderFrame(
  frame: Frame,
  plan: ClipPlan,
  frameIndex: number,
  map: AlphaMap
): RenderReport {
  let applied = 0
  let skipped = 0

  for (const track of plan.tracks) {
    const entry = track.frames.get(frameIndex)
    if (!entry) continue
    if (entry.state === "occluded") {
      skipped++
      continue
    }
    const scaled = scaleAlphaMap(map, entry.rect.width, entry.rect.height)
    unblend(frame, scaled, entry.rect, { gain: entry.alpha })
    applied++
  }

  return { applied, skipped }
}
