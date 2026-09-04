import { ALPHA_THRESHOLD, LOGO_VALUE, MAX_ALPHA } from "./constants.ts"
import type { Grayscale } from "./correlate.ts"
import { scaleAlphaMap } from "./alpha-map.ts"
import type { AlphaMap, Rect } from "./types.ts"

/**
 * Reversibility verification — deciding whether a candidate region is actually an
 * alpha composite, and if so at what intensity.
 *
 * This is the idea that makes searching the whole frame practical. Correlation alone
 * cannot tell a watermark from a lens flare, a specular highlight, or a white logo in
 * the content; all of them score well against a small bright template. But a genuine
 * alpha composite has a property real content does not: it can be *inverted* into
 * something consistent with its surroundings.
 *
 * So we solve for the intensity that best blends the patch back into the background
 * ring around it:
 *
 *   - some intensity makes the patch indistinguishable from its neighbourhood
 *       -> it was a composite, and we have just measured its alpha
 *   - no intensity works: always too bright (residue) or punching a dark hole
 *       -> it is real content, leave it alone
 *
 * Consistency alone is not sufficient, though. As gain approaches zero the correction
 * approaches doing nothing, and doing nothing to a patch of ordinary background is
 * trivially "consistent" with the background around it — so a naive residual test
 * accepts every flat region in the frame. A composite must therefore also be visibly
 * *brighter* than its surroundings to begin with, since that is what compositing white
 * does. We require both: a real lift before correction, and consistency after it.
 *
 * The search is a bisection, because the residual is monotonic in gain: more gain
 * always subtracts more white. Prior art uses this loop to *tune* removal strength at
 * a known location; here it also decides whether there is anything to remove at all.
 *
 * Everything runs on luminance rather than per channel. Unblending is affine per
 * channel and luma is a linear combination whose weights sum to one, so
 * `luma((v - a*255)/(1-a)) === (luma(v) - a*255)/(1-a)`. Working in grayscale is
 * therefore exact here, not an approximation, and three times cheaper.
 */

export interface VerifyOptions {
  /** Lowest intensity considered. */
  readonly minGain?: number
  /** Highest intensity considered. */
  readonly maxGain?: number
  /** Bisection rounds. Five gets within ~3% of the range. */
  readonly rounds?: number
  /** Thickness in pixels of the background ring sampled around the candidate. */
  readonly ringWidth?: number
  /**
   * How close the corrected patch must sit to the background, in units of the ring's
   * own standard deviation. Scale-free, so it behaves the same on flat sky and on
   * busy foliage.
   */
  readonly acceptZScore?: number
  /**
   * How much brighter than the background the patch must be *before* correction, in
   * ring standard deviations. Without this floor, "correct nothing" passes the
   * consistency test on any ordinary patch of background.
   */
  readonly minLiftZ?: number
}

export interface VerifyResult {
  /** Whether some intensity reconciled the patch with its surroundings. */
  readonly isComposite: boolean
  /** The intensity that did it, or the best attempt if none did. */
  readonly gain: number
  /** Signed distance from the background mean, in ring standard deviations. */
  readonly residualZ: number
  /**
   * How far above the background the patch sat before any correction, in ring
   * standard deviations. Near zero means there was nothing there to remove;
   * negative means the region is darker than its surroundings.
   */
  readonly liftZ: number
  readonly ringMean: number
  readonly ringStd: number
  /** Number of ring pixels sampled. Low counts make the verdict unreliable. */
  readonly ringSamples: number
  /** Set when the region could not be judged, e.g. too few ring pixels. */
  readonly inconclusive: boolean
}

const DEFAULTS = {
  minGain: 0.05,
  maxGain: 1.5,
  rounds: 6,
  ringWidth: 6,
  acceptZScore: 0.6,
  minLiftZ: 0.75,
} as const

export function verifyReversibility(
  image: Grayscale,
  alphaTemplate: AlphaMap,
  rect: Rect,
  options: VerifyOptions = {}
): VerifyResult {
  const minGain = options.minGain ?? DEFAULTS.minGain
  const maxGain = options.maxGain ?? DEFAULTS.maxGain
  const rounds = options.rounds ?? DEFAULTS.rounds
  const ringWidth = options.ringWidth ?? DEFAULTS.ringWidth
  const acceptZScore = options.acceptZScore ?? DEFAULTS.acceptZScore
  const minLiftZ = options.minLiftZ ?? DEFAULTS.minLiftZ

  if (minGain <= 0 || maxGain <= minGain) {
    throw new RangeError(`gain range must be positive and increasing, got ${minGain}..${maxGain}`)
  }

  const alpha = scaleAlphaMap(alphaTemplate, rect.width, rect.height)
  const ring = sampleRing(image, rect, ringWidth)

  // Without a usable background there is nothing to be consistent *with*. Say so
  // rather than guessing — a fabricated verdict here becomes a false detection.
  if (ring.count < 16 || ring.std < 1e-6) {
    return {
      isComposite: false,
      gain: minGain,
      residualZ: Number.POSITIVE_INFINITY,
      liftZ: 0,
      ringMean: ring.mean,
      ringStd: ring.std,
      ringSamples: ring.count,
      inconclusive: true,
    }
  }

  // How much the mark lifted this region above its surroundings. Measured with the
  // template's own weighting so it reflects the mark's footprint, not the whole rect.
  const liftZ = (weightedMean(image, alpha, rect) - ring.mean) / ring.std

  // Residual decreases monotonically as gain rises, so plain bisection converges.
  let lo = minGain
  let hi = maxGain
  let best = { gain: minGain, residual: Number.POSITIVE_INFINITY }

  for (let i = 0; i < rounds; i++) {
    const mid = (lo + hi) / 2
    const residual = correctedMean(image, alpha, rect, mid) - ring.mean

    if (Math.abs(residual) < Math.abs(best.residual)) {
      best = { gain: mid, residual }
    }
    if (residual > 0) lo = mid
    else hi = mid
  }

  const residualZ = best.residual / ring.std
  return {
    // Both conditions: the mark actually brightened this region, and some intensity
    // put it back in line with its neighbourhood.
    isComposite: liftZ >= minLiftZ && Math.abs(residualZ) <= acceptZScore,
    gain: best.gain,
    residualZ,
    liftZ,
    ringMean: ring.mean,
    ringStd: ring.std,
    ringSamples: ring.count,
    inconclusive: false,
  }
}

/** Alpha-weighted mean luminance of the patch as it stands, with no correction. */
function weightedMean(image: Grayscale, alpha: AlphaMap, rect: Rect): number {
  let weighted = 0
  let weight = 0

  const startRow = Math.max(0, -rect.y)
  const endRow = Math.min(rect.height, image.height - rect.y)
  const startCol = Math.max(0, -rect.x)
  const endCol = Math.min(rect.width, image.width - rect.x)

  for (let row = startRow; row < endRow; row++) {
    const imageRow = (rect.y + row) * image.width
    const alphaRow = row * alpha.width
    for (let col = startCol; col < endCol; col++) {
      const a = alpha.data[alphaRow + col] as number
      if (a < ALPHA_THRESHOLD) continue
      weighted += a * (image.data[imageRow + rect.x + col] as number)
      weight += a
    }
  }
  return weight > 0 ? weighted / weight : 0
}

/**
 * Alpha-weighted mean luminance of the patch after unblending at `gain`.
 *
 * Weighting by alpha matters: pixels the mark barely touches are unchanged by the
 * correction, and letting them vote would dilute the very signal we are measuring.
 */
function correctedMean(image: Grayscale, alpha: AlphaMap, rect: Rect, gain: number): number {
  let weighted = 0
  let weight = 0

  const startRow = Math.max(0, -rect.y)
  const endRow = Math.min(rect.height, image.height - rect.y)
  const startCol = Math.max(0, -rect.x)
  const endCol = Math.min(rect.width, image.width - rect.x)

  for (let row = startRow; row < endRow; row++) {
    const imageRow = (rect.y + row) * image.width
    const alphaRow = row * alpha.width

    for (let col = startCol; col < endCol; col++) {
      let a = (alpha.data[alphaRow + col] as number) * gain
      if (a < ALPHA_THRESHOLD) continue
      if (a > MAX_ALPHA) a = MAX_ALPHA

      const v = image.data[imageRow + rect.x + col] as number
      weighted += a * ((v - a * LOGO_VALUE) / (1 - a))
      weight += a
    }
  }

  return weight > 0 ? weighted / weight : 0
}

interface RingStats {
  readonly mean: number
  readonly std: number
  readonly count: number
}

/**
 * Mean and standard deviation of the annulus around `rect`, excluding the rect itself
 * and clipped to the frame. This is the "surroundings" the corrected patch is judged
 * against.
 */
function sampleRing(image: Grayscale, rect: Rect, ringWidth: number): RingStats {
  const x0 = Math.max(0, rect.x - ringWidth)
  const y0 = Math.max(0, rect.y - ringWidth)
  const x1 = Math.min(image.width, rect.x + rect.width + ringWidth)
  const y1 = Math.min(image.height, rect.y + rect.height + ringWidth)

  let sum = 0
  let sumSq = 0
  let count = 0

  for (let y = y0; y < y1; y++) {
    const insideRows = y >= rect.y && y < rect.y + rect.height
    for (let x = x0; x < x1; x++) {
      if (insideRows && x >= rect.x && x < rect.x + rect.width) continue
      const v = image.data[y * image.width + x] as number
      sum += v
      sumSq += v * v
      count++
    }
  }

  if (count === 0) return { mean: 0, std: 0, count: 0 }
  const mean = sum / count
  return { mean, std: Math.sqrt(Math.max(0, sumSq / count - mean * mean)), count }
}
