import {
  analyseFrame,
  DEFAULT_DISCOVERY_THRESHOLD,
  defaultSizes,
  overlap,
  scoreAt,
  sizeTemplate,
  sweepFrame,
  type SizedTemplate,
} from "./detect.ts"
import { referenceKernel, toGrayscale, type CorrelationKernel, type Grayscale } from "./correlate.ts"
import { verifyReversibility, type VerifyOptions, type VerifyResult } from "./verify.ts"
import type { AlphaMap, Frame, Rect } from "./types.ts"

/**
 * The residual check: what the finished render still shows.
 *
 * Every count this engine produces describes what the *plan decided* — corrected,
 * left untouched, filled. None of them look at the picture that came out. A clip can
 * honestly report two hundred frames corrected and still carry a visible mark through
 * a shot the tracker never covered, and nothing downstream would know.
 *
 * This pass looks. It is deliberately read-only: it reports ranges and never edits,
 * because the thing that inspects a render has no business also being the thing that
 * changes it. See `docs/PLAN.md` §5, *Pass 4*.
 */

/**
 * Frames between full-frame sweeps.
 *
 * Matches the planner's own sweep cadence. Sampling is sound here for the same reason
 * it is sound there: a mark that is present is present for many consecutive frames,
 * and the case this pass exists to catch is a whole uncovered shot, not one stray
 * frame.
 */
export const DEFAULT_RESIDUAL_SWEEP_INTERVAL = 15

/**
 * Clean frames tolerated before an open leftover is declared finished.
 *
 * A leftover that flickers off for a single frame — a bright cut, a compression
 * artefact eating the lift — is still the same leftover. Closing on the first clean
 * frame would shatter one range into a dozen, which reads in the UI as a dozen
 * separate problems.
 */
const DEFAULT_GRACE = 2

/** Slack allowed when following a known leftover into the next frame, in pixels. */
const FOLLOW_RADIUS = 4

/** Step of the follow scan. Two is enough: the verifier tolerates a pixel of drift. */
const FOLLOW_STEP = 2

/** Overlap above which a sweep hit is the leftover we are already following. */
const SAME_LEFTOVER_OVERLAP = 0.3

/**
 * Why a region is still marked.
 *
 * The distinction is worth keeping because it points at different faults. An
 * `under-corrected` region is one the plan touched and did not finish — a tracking or
 * alpha problem. A `missed` one is a place the plan never reached at all, which is a
 * discovery problem, and discovery is exactly what the segmenter in §5 is meant to fix.
 */
/**
 * The only thing the check needs from a plan: which rectangles were touched, and when.
 *
 * Narrower than `WatermarkTrack` on purpose. A `WatermarkTrack` satisfies it, and so
 * does a plan reloaded from disk long after the run that produced it — which is what
 * makes re-checking a stored render give the same answer as the run did, rather than
 * quietly losing the under-shoot question along with the tracker's state.
 */
export interface TouchedTrack {
  readonly frames: ReadonlyMap<number, { readonly rect: Rect }>
}

export type ResidualKind = "missed" | "under-corrected"

/** A stretch of frames where something still reads as a mark. */
export interface ResidualRange {
  readonly from: number
  /** Inclusive. */
  readonly to: number
  /** Where it was last seen. A roaming leftover moves, so this is not the whole story. */
  readonly rect: Rect
  readonly kind: ResidualKind
  /** Highest fused detection score observed across the range. */
  readonly peakScore: number
  /** The intensity the verifier settled on where the score peaked. */
  readonly peakAlpha: number
}

export interface ResidualReport {
  readonly framesChecked: number
  /** How many frames got a full-frame sweep, as opposed to a local re-score. */
  readonly sweeps: number
  readonly ranges: readonly ResidualRange[]
  /** Distinct frames where something still reads as a mark. */
  readonly framesMarked: number
  /**
   * Frames between sweeps, carried so a range's start can be read for what it is.
   *
   * A leftover is followed forward from the sampled frame that found it, never
   * backward — the frames before it are already decoded and gone. So `from` is the
   * first frame *confirmed* to show the mark, and the mark may have appeared up to
   * this many frames earlier. The report says so rather than rounding the range
   * outward and presenting a guess as a measurement.
   */
  readonly sweepInterval: number
}

export interface ResidualOptions {
  /**
   * Where the plan corrected, so an under-shoot is caught without any searching.
   *
   * Re-scoring a rectangle the plan already touched costs one template correlation.
   * Finding the same fault by sweeping would cost a full-frame search on every frame,
   * which is precisely what neither this pass nor Pass 1 can afford.
   */
  readonly tracks?: readonly TouchedTrack[]
  readonly sweepInterval?: number
  /**
   * Fused score a sweep hit must reach.
   *
   * The discovery bar, not the tracking bar. A leftover has no track history to lend
   * it credibility — flagging one is the "believe this frame alone" decision that
   * `docs/PLAN.md` §4 sets the higher bar for.
   */
  readonly discoveryThreshold?: number
  readonly sizes?: readonly number[]
  readonly kernel?: CorrelationKernel
  readonly verify?: VerifyOptions
  readonly grace?: number
}

export interface ResidualChecker {
  /** Feeds the next frame of the render. Frames must arrive in order from index 0. */
  push(frame: Frame): void
  finish(): ResidualReport
}

/** A leftover currently being followed. */
interface OpenRange {
  from: number
  to: number
  rect: Rect
  kind: ResidualKind
  peakScore: number
  peakAlpha: number
  /** Consecutive frames it has failed to show up on. */
  missed: number
}

export function createResidualChecker(
  map: AlphaMap,
  options: ResidualOptions = {}
): ResidualChecker {
  const sweepInterval = Math.max(1, options.sweepInterval ?? DEFAULT_RESIDUAL_SWEEP_INTERVAL)
  const discoveryThreshold = options.discoveryThreshold ?? DEFAULT_DISCOVERY_THRESHOLD
  const kernel = options.kernel ?? referenceKernel
  const grace = options.grace ?? DEFAULT_GRACE
  const tracks = options.tracks ?? []

  const templates = new Map<number, SizedTemplate>()
  const flagged = new Set<number>()
  const closed: ResidualRange[] = []
  let open: OpenRange[] = []
  let sizes: readonly number[] | null = null
  let index = 0
  let sweeps = 0

  function templateFor(size: number): SizedTemplate {
    let sized = templates.get(size)
    if (!sized) {
      sized = sizeTemplate(map, size)
      templates.set(size, sized)
    }
    return sized
  }

  /**
   * Whether this rectangle still contains a removable composite.
   *
   * The verifier is the right instrument rather than the detector: after a correct
   * removal the patch sits at the background level, so its lift over the surrounding
   * ring collapses and `isComposite` goes false on its own. A correlation score, by
   * contrast, stays high on any diamond-shaped piece of content whether or not it was
   * ever a watermark.
   */
  function stillMarked(image: Grayscale, rect: Rect): VerifyResult | null {
    const result = verifyReversibility(image, map, rect, options.verify ?? {})
    if (!result.isComposite || !result.bracketed || result.inconclusive) return null
    return result
  }

  function fusedScore(analysis: ReturnType<typeof analyseFrame>, rect: Rect): number {
    return scoreAt(analysis, templateFor(rect.width), rect.x, rect.y, kernel).score
  }

  function alreadyFollowing(rect: Rect): boolean {
    return open.some((entry) => overlap(entry.rect, rect) > SAME_LEFTOVER_OVERLAP)
  }

  function record(rect: Rect, kind: ResidualKind, score: number, alpha: number): void {
    open.push({ from: index, to: index, rect, kind, peakScore: score, peakAlpha: alpha, missed: 0 })
    flagged.add(index)
  }

  function close(entry: OpenRange): void {
    closed.push({
      from: entry.from,
      to: entry.to,
      rect: entry.rect,
      kind: entry.kind,
      peakScore: entry.peakScore,
      peakAlpha: entry.peakAlpha,
    })
  }

  function push(frame: Frame): void {
    const image = toGrayscale(frame)
    const analysis = analyseFrame(image)
    sizes ??= options.sizes ?? defaultSizes(frame.width, frame.height)

    // 1. Follow what is already known, before anything else claims it. A leftover
    //    being tracked must not also be re-discovered by the sweep as a second one.
    const surviving: OpenRange[] = []
    for (const entry of open) {
      const found = follow(image, analysis, entry)
      if (found) {
        entry.rect = found.rect
        entry.to = index
        entry.missed = 0
        if (found.score > entry.peakScore) {
          entry.peakScore = found.score
          entry.peakAlpha = found.alpha
        }
        flagged.add(index)
        surviving.push(entry)
      } else if (entry.missed < grace) {
        entry.missed++
        surviving.push(entry)
      } else {
        close(entry)
      }
    }
    open = surviving

    // 2. Did a correction under-shoot? Every frame, at the rectangles the plan already
    //    touched. No search, so this is affordable on all of them.
    for (const track of tracks) {
      const at = track.frames.get(index)
      if (!at || alreadyFollowing(at.rect)) continue
      const verdict = stillMarked(image, at.rect)
      if (verdict) record(at.rect, "under-corrected", fusedScore(analysis, at.rect), verdict.gain)
    }

    // 3. Was a mark missed entirely? Bounded sweep, at the discovery bar.
    if (index % sweepInterval === 0) {
      sweeps++
      const hits = sweepFrame(analysis, map, {
        kernel,
        threshold: discoveryThreshold,
        sizes,
      })
      for (const hit of hits) {
        if (hit.score < discoveryThreshold || alreadyFollowing(hit.rect)) continue
        const verdict = stillMarked(image, hit.rect)
        if (verdict) record(hit.rect, "missed", hit.score, verdict.gain)
      }
    }

    index++
  }

  /** Re-finds a known leftover in this frame, allowing for a little drift. */
  function follow(
    image: Grayscale,
    analysis: ReturnType<typeof analyseFrame>,
    entry: OpenRange
  ): { rect: Rect; score: number; alpha: number } | null {
    const template = templateFor(entry.rect.width)
    let best: { rect: Rect; score: number } | null = null

    for (let dy = -FOLLOW_RADIUS; dy <= FOLLOW_RADIUS; dy += FOLLOW_STEP) {
      for (let dx = -FOLLOW_RADIUS; dx <= FOLLOW_RADIUS; dx += FOLLOW_STEP) {
        const x = entry.rect.x + dx
        const y = entry.rect.y + dy
        if (x < 0 || y < 0) continue
        if (x + entry.rect.width > image.width || y + entry.rect.height > image.height) continue
        const candidate = scoreAt(analysis, template, x, y, kernel)
        if (!best || candidate.score > best.score) {
          best = { rect: candidate.rect, score: candidate.score }
        }
      }
    }

    if (!best) return null
    const verdict = stillMarked(image, best.rect)
    return verdict ? { rect: best.rect, score: best.score, alpha: verdict.gain } : null
  }

  function finish(): ResidualReport {
    for (const entry of open) close(entry)
    open = []
    closed.sort((a, b) => a.from - b.from || a.to - b.to)
    return {
      framesChecked: index,
      sweeps,
      ranges: closed,
      framesMarked: flagged.size,
      sweepInterval,
    }
  }

  return { push, finish }
}

/** Convenience for stills and tests: check a whole sequence held in memory. */
export function checkResidual(
  frames: readonly Frame[],
  map: AlphaMap,
  options: ResidualOptions = {}
): ResidualReport {
  const checker = createResidualChecker(map, options)
  for (const frame of frames) checker.push(frame)
  return checker.finish()
}
