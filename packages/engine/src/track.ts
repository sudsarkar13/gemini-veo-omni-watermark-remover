import { ALPHA_STEP_CAP } from "./constants.ts"
import type { FrameState, MarkVariant, Rect, TrackedFrame, WatermarkTrack } from "./types.ts"

/**
 * Tracking a watermark through time, and consolidating those observations once the
 * whole clip has been seen.
 *
 * The output of detection is a set of tracks, not a rectangle. That is what lets us
 * describe a mark which fades in mid-scene, drifts, and vanishes — the case every
 * existing tool is structurally unable to represent.
 *
 * Consolidation runs after the entire timeline is known, which is the advantage a
 * native two-pass tool has over the browser tools. They stream, so they can only ever
 * react to frames already seen; we can interpolate a mark's position through an
 * occlusion using evidence from both sides of it.
 */

export interface Observation {
  readonly rect: Rect
  readonly alpha: number
  readonly confidence: number
  /** True when this came from a region the user pointed at rather than a search. */
  readonly manual?: boolean
}

export interface MutableTrack {
  readonly id: string
  variant: MarkVariant
  readonly frames: Map<number, TrackedFrame>
  firstFrame: number
  lastFrame: number
  /** Consecutive frames since this track was last matched to an observation. */
  misses: number
  /** Set once any observation in this track came from a user-drawn region. */
  manual: boolean
}

export interface TrackOptions {
  /** How far a mark's centre may move between frames and still be the same mark. */
  readonly matchRadius?: number
  /** Unmatched frames tolerated before a track is considered ended. */
  readonly missTolerance?: number
  /** Observed frames a track needs before it is believed at all. */
  readonly minPersistence?: number
  /**
   * Longest gap that may be bridged by interpolation. Beyond this we admit we do not
   * know where the mark was and leave those frames untouched.
   */
  readonly maxInterpolationGap?: number
  readonly alphaStepCap?: number
  /**
   * Window for the temporal median applied to track position. Odd, or 1 to disable.
   */
  readonly positionWindow?: number
}

/** Match gate for a track of unknown velocity, as a fraction of the mark's size. */
const UNKNOWN_MOTION_GATE = 0.75

const DEFAULTS = {
  matchRadius: 24,
  missTolerance: 8,
  minPersistence: 8,
  maxInterpolationGap: 15,
  alphaStepCap: ALPHA_STEP_CAP,
  positionWindow: 5,
} as const

function centre(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

function distance(a: Rect, b: Rect): number {
  const ca = centre(a)
  const cb = centre(b)
  return Math.hypot(ca.x - cb.x, ca.y - cb.y)
}

/**
 * Per-frame velocity from a track's last two sightings, in pixels.
 *
 * Zero for a corner mark, and that is the case the defaults were tuned on — which is
 * why a mark travelling thirty pixels a frame could be detected on individual frames
 * and still never form a track. A mark free to appear anywhere is free to move, and
 * matching it on the assumption that it barely does makes "anywhere in the frame" mean
 * "anywhere, as long as it stays put".
 */
export function velocityOf(track: {
  frames: ReadonlyMap<number, TrackedFrame>
  lastFrame: number
}): { x: number; y: number } {
  const last = track.frames.get(track.lastFrame)
  if (!last) return { x: 0, y: 0 }

  let previousIndex = -1
  for (const index of track.frames.keys()) {
    if (index < track.lastFrame && index > previousIndex) previousIndex = index
  }
  const previous = previousIndex >= 0 ? track.frames.get(previousIndex) : undefined
  if (!previous) return { x: 0, y: 0 }

  const gap = track.lastFrame - previousIndex
  const a = centre(previous.rect)
  const b = centre(last.rect)
  return { x: (b.x - a.x) / gap, y: (b.y - a.y) / gap }
}

/** Where a track is expected to be `ahead` frames after its last sighting. */
export function predictRect(
  track: { frames: ReadonlyMap<number, TrackedFrame>; lastFrame: number },
  ahead: number
): Rect | null {
  const last = track.frames.get(track.lastFrame)
  if (!last) return null
  const v = velocityOf(track)
  return {
    ...last.rect,
    x: Math.round(last.rect.x + v.x * ahead),
    y: Math.round(last.rect.y + v.y * ahead),
  }
}

/**
 * Folds one frame's observations into the running set of tracks.
 *
 * Assignment is greedy by confidence: the strongest observation claims the nearest
 * eligible track first. A proper global assignment would be marginally better, but
 * marks are few and well separated, so the added complexity buys nothing real.
 */
export function ingestFrame(
  tracks: MutableTrack[],
  frameIndex: number,
  observations: readonly Observation[],
  options: TrackOptions = {}
): MutableTrack[] {
  const matchRadius = options.matchRadius ?? DEFAULTS.matchRadius
  const missTolerance = options.missTolerance ?? DEFAULTS.missTolerance

  const active = tracks.filter((t) => t.misses <= missTolerance)
  const claimed = new Set<string>()

  for (const observation of [...observations].sort((a, b) => b.confidence - a.confidence)) {
    let best: MutableTrack | null = null
    let bestDistance = Infinity

    for (const track of active) {
      if (claimed.has(track.id)) continue
      const last = track.frames.get(track.lastFrame)
      if (!last) continue

      // Compare against where the track was heading, not where it was last seen, and
      // widen the gate by how fast it is going. A tolerance that is generous for a
      // stationary mark is nothing at all for one crossing the frame.
      const ahead = frameIndex - track.lastFrame
      const predicted = predictRect(track, ahead) ?? last.rect
      const v = velocityOf(track)
      const speed = Math.hypot(v.x, v.y)
      // A track seen only once has no velocity to predict from, so the gate falls back
      // to the mark's own size — the scale of a step it could plausibly have taken.
      const unknown = track.frames.size < 2
      const gate = unknown
        ? matchRadius + last.rect.width * UNKNOWN_MOTION_GATE
        : matchRadius + speed * Math.max(1, ahead)

      const d = distance(predicted, observation.rect)
      if (d <= gate && d < bestDistance) {
        best = track
        bestDistance = d
      }
    }

    if (best) {
      claimed.add(best.id)
      best.frames.set(frameIndex, { ...observation, state: "detected" })
      best.lastFrame = frameIndex
      best.misses = 0
      if (observation.manual === true) best.manual = true
    } else {
      const track: MutableTrack = {
        id: `track-${tracks.length + 1}`,
        variant: "gemini-v1-48",
        frames: new Map([[frameIndex, { ...observation, state: "detected" as FrameState }]]),
        firstFrame: frameIndex,
        lastFrame: frameIndex,
        misses: 0,
        manual: observation.manual === true,
      }
      tracks.push(track)
    }
  }

  for (const track of tracks) {
    if (!claimed.has(track.id) && track.lastFrame !== frameIndex) track.misses++
  }

  return tracks
}

export interface ConsolidationResult {
  readonly tracks: WatermarkTrack[]
  /** Tracks discarded for never reaching the persistence threshold. */
  readonly rejected: number
}

/**
 * Second pass over the finished timeline.
 *
 * Three things happen here that a streaming pipeline cannot do:
 *
 *  1. Tracks that never persisted are dropped. A lens flare will not hold a coherent
 *     position with a stable alpha across many consecutive frames; a watermark will.
 *     This is where most false positives die.
 *  2. Short gaps are bridged by interpolating from both sides. Prior art skips
 *     occluded frames outright; having the future available usually recovers them.
 *  3. Alpha is smoothed with a per-frame step cap, so one bad measurement cannot
 *     become a visible flash.
 */
export function consolidate(
  tracks: readonly MutableTrack[],
  options: TrackOptions = {},
  /**
   * Total frames in the clip, so persistence is judged against the evidence that
   * could exist rather than an absolute count. Omit to judge against the count alone.
   */
  frameCount?: number
): ConsolidationResult {
  const minPersistence = options.minPersistence ?? DEFAULTS.minPersistence
  const maxGap = options.maxInterpolationGap ?? DEFAULTS.maxInterpolationGap
  const stepCap = options.alphaStepCap ?? DEFAULTS.alphaStepCap
  const positionWindow = options.positionWindow ?? DEFAULTS.positionWindow

  const kept: WatermarkTrack[] = []
  let rejected = 0

  for (const track of tracks) {
    // Persistence is a stand-in for corroboration, and a region the user drew is
    // corroboration of a better kind than any amount of repetition. Discarding it for
    // being brief would make the manual tool useless exactly where it is needed: on
    // marks too fleeting for the detector to have trusted on its own.
    if (
      !track.manual &&
      track.frames.size < requiredPersistence(track, minPersistence, frameCount)
    ) {
      rejected++
      continue
    }

    const observed = [...track.frames.keys()].sort((a, b) => a - b)
    const frames = new Map<number, TrackedFrame>(track.frames)

    for (let i = 0; i < observed.length - 1; i++) {
      const from = observed[i] as number
      const to = observed[i + 1] as number
      const gap = to - from - 1
      if (gap <= 0) continue

      const a = track.frames.get(from) as TrackedFrame
      const b = track.frames.get(to) as TrackedFrame

      // Beyond the bridgeable gap we do not know where the mark was. Marking these
      // occluded leaves them untouched in the render, which is honest; inventing a
      // position would smear a correction across the wrong pixels.
      const state: FrameState = gap <= maxGap ? "interpolated" : "occluded"

      for (let f = from + 1; f < to; f++) {
        const t = (f - from) / (to - from)
        frames.set(f, {
          rect: lerpRect(a.rect, b.rect, t),
          alpha: a.alpha + (b.alpha - a.alpha) * t,
          confidence: Math.min(a.confidence, b.confidence) * (state === "occluded" ? 0 : 1 - t * (1 - t) * 2),
          state,
        })
      }
    }

    kept.push({
      id: track.id,
      variant: track.variant,
      frames: smoothAlpha(smoothPositions(frames, positionWindow), stepCap),
      firstFrame: observed[0] as number,
      lastFrame: observed.at(-1) as number,
    })
  }

  return { tracks: kept, rejected }
}

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    x: Math.round(a.x + (b.x - a.x) * t),
    y: Math.round(a.y + (b.y - a.y) * t),
    width: Math.round(a.width + (b.width - a.width) * t),
    height: Math.round(a.height + (b.height - a.height) * t),
  }
}

/**
 * Temporal median filter over track position.
 *
 * Position is estimated independently per frame, so a stationary mark jitters by a
 * pixel as noise moves the correlation peak around. That matters far more than it
 * sounds: measured against ground truth, a one-pixel offset costs roughly six times
 * the error of a 0.03 alpha error, because the mark's alpha falls off steeply at its
 * rim and a misaligned correction leaves bright and dark crescents.
 *
 * A median rather than a mean, so genuine motion is followed without being smeared,
 * while isolated single-frame excursions are discarded outright.
 */
function smoothPositions(
  frames: ReadonlyMap<number, TrackedFrame>,
  window: number
): Map<number, TrackedFrame> {
  if (window <= 1) return new Map(frames)

  const ordered = [...frames.keys()].sort((a, b) => a - b)
  const half = Math.floor(window / 2)
  const out = new Map<number, TrackedFrame>()

  for (let i = 0; i < ordered.length; i++) {
    const index = ordered[i] as number
    const frame = frames.get(index) as TrackedFrame

    // Occluded frames are not corrected, so their position is not a measurement and
    // must not influence its neighbours.
    if (frame.state === "occluded") {
      out.set(index, frame)
      continue
    }

    // Median the deviation from the track's local motion, not the position itself.
    //
    // A plain median assumes the mark is standing still and jitter is all it sees. On
    // a mark that is actually travelling, the neighbours it averages over are at
    // genuinely different places, so it drags the position backwards along the path —
    // a mark moving thirty pixels a frame ends up corrected a whole frame behind
    // itself, which subtracts the template from the wrong pixels twice over. Fitting
    // the straight line first and medianing what is left over keeps the jitter
    // rejection and leaves constant motion untouched.
    const window: { t: number; x: number; y: number }[] = []
    for (let j = Math.max(0, i - half); j <= Math.min(ordered.length - 1, i + half); j++) {
      const at = ordered[j] as number
      const neighbour = frames.get(at) as TrackedFrame
      if (neighbour.state === "occluded") continue
      window.push({ t: at, x: neighbour.rect.x, y: neighbour.rect.y })
    }

    const trend = fitLine(window)
    const atIndex = { x: trend.x0 + trend.vx * index, y: trend.y0 + trend.vy * index }
    const xs = window.map((p) => p.x - (trend.x0 + trend.vx * p.t))
    const ys = window.map((p) => p.y - (trend.y0 + trend.vy * p.t))

    out.set(index, {
      ...frame,
      rect: {
        ...frame.rect,
        x: Math.round(atIndex.x + median(xs)),
        y: Math.round(atIndex.y + median(ys)),
      },
    })
  }

  return out
}

/**
 * Least-squares straight line through a window of positions, expressed at `t = 0`.
 *
 * Two points define the velocity exactly and fewer define none, which is the right
 * answer for a track too short to have shown its motion yet.
 */
function fitLine(points: readonly { t: number; x: number; y: number }[]): {
  x0: number
  y0: number
  vx: number
  vy: number
} {
  const n = points.length
  if (n === 0) return { x0: 0, y0: 0, vx: 0, vy: 0 }

  const meanT = points.reduce((s, p) => s + p.t, 0) / n
  const meanX = points.reduce((s, p) => s + p.x, 0) / n
  const meanY = points.reduce((s, p) => s + p.y, 0) / n

  let varT = 0
  let covX = 0
  let covY = 0
  for (const p of points) {
    const dt = p.t - meanT
    varT += dt * dt
    covX += dt * (p.x - meanX)
    covY += dt * (p.y - meanY)
  }

  const vx = varT > 0 ? covX / varT : 0
  const vy = varT > 0 ? covY / varT : 0
  return { x0: meanX - vx * meanT, y0: meanY - vy * meanT, vx, vy }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2)
}

/**
 * Limits how fast alpha may change from one frame to the next.
 *
 * Occluded frames are skipped rather than smoothed: they are not being corrected, so
 * their alpha is not a measurement and must not drag the neighbouring values around.
 */
function smoothAlpha(
  frames: ReadonlyMap<number, TrackedFrame>,
  stepCap: number
): Map<number, TrackedFrame> {
  const ordered = [...frames.keys()].sort((a, b) => a - b)
  const out = new Map<number, TrackedFrame>()
  let previous: number | null = null

  for (const index of ordered) {
    const frame = frames.get(index) as TrackedFrame
    if (frame.state === "occluded") {
      out.set(index, frame)
      continue
    }
    if (previous === null) {
      out.set(index, frame)
      previous = frame.alpha
      continue
    }
    // Bind to a local so the inference of `previous` does not depend on `alpha`,
    // which is itself derived from `previous`.
    const base: number = previous
    const delta = Math.max(-stepCap, Math.min(stepCap, frame.alpha - base))
    const alpha = base + delta
    out.set(index, { ...frame, alpha })
    previous = alpha
  }

  return out
}

/** Convenience: run a whole clip's observations through both passes. */
export function buildTracks(
  perFrame: readonly (readonly Observation[])[],
  options: TrackOptions = {}
): ConsolidationResult {
  const tracks: MutableTrack[] = []
  perFrame.forEach((observations, index) => ingestFrame(tracks, index, observations, options))
  return consolidate(tracks, options, perFrame.length)
}

/**
 * How many frames this particular track has to hold for before it is believed.
 *
 * Persistence is a proxy for corroboration: a lens flare will not keep a coherent
 * position and a stable alpha for long, and a watermark will. But the clip's own ends
 * bound how much corroboration can exist at all. A mark that appears three frames
 * before the last one cannot hold for eight, and demanding it discards a real
 * detection for failing to provide evidence the clip never had — which is how a
 * roaming mark, visible only as an object swings past the camera at the end of a
 * shot, went unremoved while the corner mark was handled perfectly.
 *
 * So the bar is the full requirement or the room available, whichever is smaller.
 * Mid-clip nothing changes; only at the ends does it relax, and only to what the
 * footage could possibly show.
 */
function requiredPersistence(
  track: MutableTrack,
  minPersistence: number,
  frameCount: number | undefined
): number {
  if (frameCount === undefined || frameCount <= 0) return minPersistence
  const observed = [...track.frames.keys()]
  const first = Math.min(...observed)
  const last = Math.max(...observed)
  return Math.min(minPersistence, frameCount - first, last + 1)
}
