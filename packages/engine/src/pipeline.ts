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
  DEFAULT_DISCOVERY_THRESHOLD,
  DEFAULT_THRESHOLD,
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
  /**
   * Fused score a sweep candidate needs before it may start a new track. Defaults to
   * `DEFAULT_DISCOVERY_THRESHOLD`; lower it only with a fixture that justifies it.
   */
  readonly discoveryThreshold?: number
  /**
   * How long a location keeps being searched after the mark was last seen there.
   *
   * A place a mark has just been is a prior, so re-finding it there is not the same
   * act as discovering one somewhere new and must not be held to the same bar.
   */
  readonly reacquireFrames?: number
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
 * Frames a lost location stays worth looking at.
 *
 * Long enough that consolidation can still bridge the gap it leaves, short enough
 * that stale places do not accumulate. Beyond this the sweep is the way back.
 */
const DEFAULT_REACQUIRE_FRAMES = 30

/** Cap on remembered locations, so a busy clip cannot make every frame expensive. */
const MAX_RECENT_LOCATIONS = 8

/** Search slack for a location of unknown velocity, as a fraction of the mark's size. */
const UNKNOWN_MOTION_SLACK = 0.75

/**
 * Longest gap over which a re-sighting still says something about velocity.
 *
 * Across a longer absence the mark could have gone anywhere and come back; dividing
 * the displacement by the gap would invent a slow drift that was never observed.
 */
const MAX_VELOCITY_GAP = 4

/** A place the mark has been, with what is known about how it was moving. */
interface RecentLocation {
  rect: Rect
  /** Pixels per frame, or null before a second sighting has established it. */
  velocity: { x: number; y: number } | null
  sightings: number
  lastSeen: number
}

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
  const discoveryThreshold = options.discoveryThreshold ?? DEFAULT_DISCOVERY_THRESHOLD
  const reacquireFrames = options.reacquireFrames ?? DEFAULT_REACQUIRE_FRAMES

  const started = Date.now()
  const perFrame: Observation[][] = []
  const reports: FrameReport[] = []

  let width = 0
  let height = 0
  let sweeps = 0
  let index = 0
  /**
   * Where the mark has recently been, not merely where it was last frame.
   *
   * Following used to be seeded from the previous frame's observations alone, so a
   * single frame the verifier declined erased the tracker's memory entirely. From
   * then on the mark could only be found again by a full-frame sweep, which has to
   * clear the much higher discovery bar — and on a bright, busy background it cannot.
   * That is how sixteen frames of a real clip kept their watermark: the track broke
   * on one frame and could not be re-acquired for another sixteen, at a location we
   * had been tracking confidently a moment earlier.
   */
  let recent: RecentLocation[] = []
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
      mode !== "corner" && (recent.length === 0 || index % sweepInterval === 0)
    if (shouldSweep) sweeps++

    const candidates = collectCandidates(
      analysis,
      map,
      templates as SizedTemplate[],
      // Search where each location is heading, not where it was last seen. A mark
      // crossing the frame at thirty pixels a frame leaves an eight-pixel window
      // behind on the very next one.
      recent.map((entry) => predictedSearch(entry, index)),
      {
        shouldSweep,
        mode,
        trackRadius,
        width,
        height,
        discoveryThreshold,
        trackingThreshold: options.threshold ?? DEFAULT_THRESHOLD,
      },
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

    for (const observation of observations) {
      const known =
        recent.find((entry) => overlap(entry.rect, observation.rect) > 0.3) ??
        recent.find(
          (entry) => overlap(predictedSearch(entry, index).rect, observation.rect) > 0.3
        )
      if (known) {
        const gap = index - known.lastSeen
        // Velocity survives a gap. Re-deriving it only from consecutive sightings
        // means any frame the verifier declines leaves the location claiming to know
        // nothing about its own motion, and a mark that has sat still for seventy
        // frames casts about as widely as one just discovered — which is how the
        // corner track stepped onto a passing highlight and walked off across the
        // frame.
        if (gap > 0 && gap <= MAX_VELOCITY_GAP) {
          known.velocity = {
            x: (observation.rect.x - known.rect.x) / gap,
            y: (observation.rect.y - known.rect.y) / gap,
          }
        }
        known.rect = observation.rect
        known.lastSeen = index
        known.sightings++
      } else {
        recent.push({ rect: observation.rect, velocity: null, sightings: 1, lastSeen: index })
      }
    }
    recent = recent
      .filter((entry) => index - entry.lastSeen <= reacquireFrames)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, MAX_RECENT_LOCATIONS)
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

/**
 * A remembered location advanced by its own motion, with a window that grows to match.
 *
 * A stationary mark needs a few pixels of slack; one travelling across the frame needs
 * its whole displacement, or following it costs a fresh full-frame discovery every
 * single frame — which the discovery bar will usually refuse.
 */
function predictedSearch(entry: RecentLocation, index: number): { rect: Rect; slack: number } {
  const ahead = Math.max(1, index - entry.lastSeen)

  // Nothing is known about a location's motion until it has been seen twice, and
  // assuming it is stationary is how a roaming mark gets lost on the very frame after
  // it is found — the window is too small to catch the second sighting that would
  // have revealed the velocity. The mark's own size is the honest scale for a step it
  // might plausibly have taken. Exactly one frame per newly found location pays this.
  if (entry.velocity === null || entry.sightings < 2) {
    return { rect: entry.rect, slack: Math.round(entry.rect.width * UNKNOWN_MOTION_SLACK) }
  }

  const { x: vx, y: vy } = entry.velocity
  return {
    rect: {
      ...entry.rect,
      x: Math.round(entry.rect.x + vx * ahead),
      y: Math.round(entry.rect.y + vy * ahead),
    },
    // Half the predicted step, so a change of speed or direction still lands inside.
    slack: Math.round(Math.hypot(vx, vy) * ahead * 0.5),
  }
}

interface CollectContext {
  readonly shouldSweep: boolean
  readonly mode: DetectionMode
  readonly trackRadius: number
  readonly width: number
  readonly height: number
  readonly discoveryThreshold: number
  /** Score a followed mark must reach in its expected place before we look wider. */
  readonly trackingThreshold: number
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
  previous: readonly { rect: Rect; slack: number }[],
  context: CollectContext,
  options: SearchOptions
): Candidate[] {
  const found: Candidate[] = []

  for (const { rect, slack } of previous) {
    // Follow an established track by position only, holding its size fixed.
    //
    // Re-choosing the size every frame looks harmless but is not: a smaller template
    // constrains fewer pixels, so it can out-score the correct one on raw
    // correlation, and the track then walks down to the smallest size on offer. Once
    // a mark's size is known it is a property of the encode, not something to
    // re-litigate frame by frame.
    const template = nearestTemplate(templates, rect.width)
    if (!template) continue

    // Look where the mark is expected first, and only cast about if it is not there.
    //
    // Searching the wide window outright returns the best-scoring position in it,
    // which is not the same thing as the mark: on a busy frame some passing highlight
    // forty pixels away outscores the real mark, the track steps onto it, and from
    // there it wanders off across the frame. Trying the tight window first keeps a
    // stationary mark pinned exactly as before, and the wide search only runs on the
    // frames where following actually failed.
    const around = (radius: number): Rect => ({
      x: rect.x - radius,
      y: rect.y - radius,
      width: radius * 2,
      height: radius * 2,
    })

    const tight = searchWindow(analysis, [template], around(context.trackRadius), options)
    if (tight && tight.score >= context.trackingThreshold) {
      found.push(tight)
      continue
    }

    const wide =
      slack > 0
        ? searchWindow(analysis, [template], around(context.trackRadius + slack), options)
        : null
    const best = wide && (!tight || wide.score > tight.score) ? wide : tight
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
      if (found.some((f) => overlap(f.rect, candidate.rect) > 0.3)) continue
      // Anything else is a new mark being proposed on this frame alone, and has to
      // clear the higher bar.
      if (candidate.score < context.discoveryThreshold) continue
      found.push(candidate)
    }
  }

  return found
}

export interface RenderReport {
  readonly applied: number
  readonly skipped: number
}

/**
 * Which frames the plan actually accounts for, and which it silently does not.
 *
 * A frame belonging to no track at all renders untouched and, until this existed, was
 * counted nowhere: `renderFrame` reports what it applied and what it deliberately
 * skipped, and a frame it was never asked about is neither. A clip could finish with
 * a run of frames still carrying the mark and be reported as clean.
 *
 * Gaps are only counted *between* the first and last frame any track covers. Outside
 * that span there is no evidence the mark was ever present, and calling those frames
 * misses would invent a failure as readily as ignoring them hides one. The span is
 * reported alongside so the caller can say what was actually examined rather than
 * implying the whole clip was.
 */
export interface FrameRange {
  readonly from: number
  /** Inclusive. */
  readonly to: number
}

export interface Coverage {
  /** First frame covered by any track, or -1 when the plan is empty. */
  readonly firstFrame: number
  /** Last frame covered by any track, or -1 when the plan is empty. */
  readonly lastFrame: number
  /** Runs inside the span that no track covers. The mark was there and we lost it. */
  readonly gaps: FrameRange[]
  readonly framesUncovered: number
}

export function coverage(tracks: readonly WatermarkTrack[]): Coverage {
  if (tracks.length === 0) {
    return { firstFrame: -1, lastFrame: -1, gaps: [], framesUncovered: 0 }
  }

  let firstFrame = Number.POSITIVE_INFINITY
  let lastFrame = Number.NEGATIVE_INFINITY
  for (const track of tracks) {
    if (track.firstFrame < firstFrame) firstFrame = track.firstFrame
    if (track.lastFrame > lastFrame) lastFrame = track.lastFrame
  }

  const covered = new Set<number>()
  for (const track of tracks) {
    for (const index of track.frames.keys()) covered.add(index)
  }

  const gaps: FrameRange[] = []
  let runStart: number | null = null
  for (let index = firstFrame; index <= lastFrame; index++) {
    if (covered.has(index)) {
      if (runStart !== null) {
        gaps.push({ from: runStart, to: index - 1 })
        runStart = null
      }
      continue
    }
    if (runStart === null) runStart = index
  }
  if (runStart !== null) gaps.push({ from: runStart, to: lastFrame })

  let framesUncovered = 0
  for (const gap of gaps) framesUncovered += gap.to - gap.from + 1

  return { firstFrame, lastFrame, gaps, framesUncovered }
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
