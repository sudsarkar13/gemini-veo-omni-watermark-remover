import { scaleAlphaMap } from "./alpha-map.ts"
import { ALPHA_THRESHOLD, LOGO_VALUE, MAX_ALPHA } from "./constants.ts"
import { unblend } from "./blend.ts"
import { toGrayscale, type Grayscale } from "./correlate.ts"
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
 * Incremental planner: feed it one frame at a time, then ask for the plan.
 *
 * Frames arrive this way rather than as an array because a clip cannot be held in
 * memory — 1080p RGB is ~6 MB per frame, so a one-minute clip is around 11 GB. The
 * planner keeps only observations, which are a few numbers per detection, so pass 1
 * streams in constant memory regardless of clip length.
 *
 * Rendering then decodes the source a second time. Two decodes is the price of the
 * two-pass design, and it is what buys the ability to correct a frame using evidence
 * from frames after it.
 */
export interface ClipPlanner {
  /** Feeds the next frame. Frames must arrive in order, starting at index 0. */
  push(frame: Frame): void
  /** Runs consolidation and returns the finished plan. */
  finish(): ClipPlan
}

export function createPlanner(map: AlphaMap, options: PlanOptions = {}): ClipPlanner {
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
  let searchSizes: readonly number[] = []

  function push(frame: Frame): void {
    if (index === 0) {
      width = frame.width
      height = frame.height
      // The template's own captured size is real prior information about how big
      // the mark is, so it always joins the search set. Without it, a supplied
      // template can be silently searched for at every size except its own.
      const sizes =
        options.sizes ?? [...new Set([...defaultSizes(width, height), map.width])].sort((a, b) => a - b)
      searchSizes = sizes
      templates = sizes.map((size) => sizeTemplate(map, size))
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
      { ...options, sizes: options.sizes ?? searchSizes }
    )

    const observations: Observation[] = []
    for (const candidate of candidates) {
      const scaled = scaleAlphaMap(map, candidate.rect.width, candidate.rect.height)

      // Settle the last pixel of position by removal quality rather than correlation.
      //
      // The correlation peak is not exactly the true position once there is noise in
      // the frame, and being one pixel out leaves a visible halo because the mark's
      // alpha falls off steeply at its edges. Residual is the thing we actually care
      // about, so it decides — nine cheap verifications per candidate.
      const best = polish(analysis.image, scaled, candidate.rect, options)

      // The verifier is the gate, not the detector. Correlation cannot tell a mark
      // from a highlight; reversibility can.
      if (!best.verdict.isComposite) continue
      observations.push({
        rect: best.rect,
        alpha: best.verdict.gain,
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

  function finish(): ClipPlan {
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

  return { push, finish }
}

/** Convenience wrapper for a clip already held in memory, such as in tests. */
export function planClip(frames: Iterable<Frame>, map: AlphaMap, options: PlanOptions = {}): ClipPlan {
  const planner = createPlanner(map, options)
  for (const frame of frames) planner.push(frame)
  return planner.finish()
}

/** Streaming variant, for frames arriving from a decoder pipe. */
export async function planClipAsync(
  frames: AsyncIterable<Frame>,
  map: AlphaMap,
  options: PlanOptions = {}
): Promise<ClipPlan> {
  const planner = createPlanner(map, options)
  for await (const frame of frames) planner.push(frame)
  return planner.finish()
}

/** The sized template closest to an established track's size. */
function nearestTemplate(
  templates: readonly SizedTemplate[],
  size: number
): SizedTemplate | null {
  let best: SizedTemplate | null = null
  let bestDelta = Infinity
  for (const template of templates) {
    const delta = Math.abs(template.size - size)
    if (delta < bestDelta) {
      best = template
      bestDelta = delta
    }
  }
  return best
}

/**
 * Nudges a candidate by up to one pixel in each direction, keeping whichever offset
 * removes most cleanly.
 *
 * Quality is judged by the edge energy left behind, not by the verifier's residual.
 * The residual is a scalar mean comparison and barely moves under a one-pixel shift,
 * so it cannot localise. A misaligned removal, by contrast, leaves bright and dark
 * crescents along the mark's rim — exactly the signature gradient energy measures.
 */
function polish(
  image: Grayscale,
  scaled: AlphaMap,
  rect: Rect,
  options: VerifyOptions
): { rect: Rect; verdict: ReturnType<typeof verifyReversibility> } {
  const base = verifyReversibility(image, scaled, rect, options)
  let best = { rect, verdict: base, energy: residualEdgeEnergy(image, scaled, rect, base.gain) }

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue
      const shifted: Rect = { ...rect, x: rect.x + dx, y: rect.y + dy }
      const verdict = verifyReversibility(image, scaled, shifted, options)
      if (verdict.inconclusive) continue
      const energy = residualEdgeEnergy(image, scaled, shifted, verdict.gain)
      if (energy < best.energy) best = { rect: shifted, verdict, energy }
    }
  }
  return best
}

/**
 * Mean gradient magnitude inside the corrected region.
 *
 * Correcting into a copy rather than the frame, since this is a trial: several
 * offsets are scored before one is chosen.
 */
function residualEdgeEnergy(
  image: Grayscale,
  scaled: AlphaMap,
  rect: Rect,
  gain: number
): number {
  const { width: w, height: h } = rect
  if (rect.x < 1 || rect.y < 1 || rect.x + w + 1 > image.width || rect.y + h + 1 > image.height) {
    return Number.POSITIVE_INFINITY
  }

  const patch = new Float32Array(w * h)
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const v = image.data[(rect.y + row) * image.width + rect.x + col] as number
      let a = (scaled.data[row * w + col] as number) * gain
      if (a < ALPHA_THRESHOLD) {
        patch[row * w + col] = v
        continue
      }
      if (a > MAX_ALPHA) a = MAX_ALPHA
      patch[row * w + col] = (v - a * LOGO_VALUE) / (1 - a)
    }
  }

  let total = 0
  let count = 0
  for (let row = 1; row < h - 1; row++) {
    for (let col = 1; col < w - 1; col++) {
      const i = row * w + col
      total += Math.abs((patch[i + 1] as number) - (patch[i - 1] as number))
      total += Math.abs((patch[i + w] as number) - (patch[i - w] as number))
      count += 2
    }
  }
  return count > 0 ? total / count : Number.POSITIVE_INFINITY
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
    // Follow an established track by position only, holding its size fixed.
    //
    // Re-choosing the size every frame looks harmless but is not: a smaller template
    // constrains fewer pixels, so it can out-score the correct one on raw
    // correlation, and the track then walks down to the smallest size on offer. Once
    // a mark's size is known it is a property of the encode, not something to
    // re-litigate frame by frame.
    const template = nearestTemplate(templates, rect.width)
    if (!template) continue

    const best = searchWindow(
      analysis,
      [template],
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
