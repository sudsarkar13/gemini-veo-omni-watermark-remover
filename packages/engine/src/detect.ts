import { scaleAlphaMap } from "./alpha-map.ts"
import {
  buildIntegral,
  makeTemplate,
  patchSum,
  patchSumSquares,
  referenceKernel,
  sobelMagnitude,
  templateFromAlphaMap,
  type CorrelationKernel,
  type Grayscale,
  type IntegralImage,
  type Template,
} from "./correlate.ts"
import type { AlphaMap, Rect } from "./types.ts"

/**
 * Watermark detection: fused multi-signal scoring over a pyramid search.
 *
 * Three signals are combined rather than trusting any one of them:
 *
 *   spatial  (0.50)  does the shape match
 *   gradient (0.30)  does the edge signature match — the diamond has hard edges,
 *                    and edge structure survives compression better than intensity
 *   variance (0.20)  does local texture look dampened — compositing a partial white
 *                    overlay compresses contrast by roughly (1 - alpha)
 *
 * All correlation is polarity-invariant. The mark brightens the frame, so against a
 * bright background the correlation flips sign while still indicating a real match;
 * taking the magnitude keeps both cases.
 *
 * Scoring here only proposes candidates. Deciding whether a candidate is genuinely a
 * composite is the verifier's job (`verify.ts`), and surviving across frames is the
 * tracker's. Detection is deliberately permissive; rejection happens downstream where
 * there is more evidence to reject with.
 */

export interface FusedWeights {
  readonly spatial: number
  readonly gradient: number
  readonly variance: number
}

export const DEFAULT_WEIGHTS: FusedWeights = {
  spatial: 0.5,
  gradient: 0.3,
  variance: 0.2,
}

/** Fused score below this is not worth passing to the verifier. */
export const DEFAULT_THRESHOLD = 0.35

/**
 * Fused score required to *start* a new track from a full-frame sweep.
 *
 * Deliberately far above `DEFAULT_THRESHOLD`, because the two decisions are not the
 * same one. Continuing to follow a mark we already believe in is cheap to get slightly
 * wrong — the track carries its own history, and one weak frame is smoothed away.
 * Admitting a new mark somewhere no prior points at is a proposal to alter pixels on
 * nothing but this frame's evidence, and content that resembles the mark is common:
 * measured against a real capture, a genuine mark scores ~0.79 while sparkles, glints
 * and bright glyphs top out around 0.5.
 *
 * The asymmetry is the point. Missing a faint mark costs one uncorrected clip; a false
 * admission subtracts a diamond-shaped hole out of someone's footage.
 */
export const DEFAULT_DISCOVERY_THRESHOLD = 0.6

/**
 * Smallest template the coarse pass may use.
 *
 * Downsampling is bounded by this rather than by a fixed factor. A template shrunk
 * below roughly this size has too few samples left to correlate meaningfully — its
 * shape has been blurred away — so an aggressive factor silently loses exactly the
 * marks the sweep exists to find.
 */
export const MIN_COARSE_TEMPLATE = 12

export interface Candidate {
  readonly rect: Rect
  readonly score: number
  readonly spatial: number
  readonly gradient: number
  readonly variance: number
}

export interface SearchOptions {
  readonly kernel?: CorrelationKernel
  readonly weights?: FusedWeights
  readonly threshold?: number
  /** Template edge lengths to try, in full-resolution pixels. */
  readonly sizes?: readonly number[]
  readonly maxCandidates?: number
  /** Downsample factor for the coarse pass. Higher is faster and blunter. */
  readonly coarseFactor?: number
  /** Full-resolution refinement window around each coarse peak, in pixels. */
  readonly refineRadius?: number
  /** Candidates overlapping more than this are treated as the same detection. */
  readonly maxOverlap?: number
}

/** Pre-analysed image planes. Built once per frame and reused across every template. */
export interface FrameAnalysis {
  readonly image: Grayscale
  readonly integral: IntegralImage
  readonly edges: Grayscale
  readonly edgeIntegral: IntegralImage
}

export function analyseFrame(image: Grayscale): FrameAnalysis {
  const edges = sobelMagnitude(image)
  return {
    image,
    integral: buildIntegral(image),
    edges,
    edgeIntegral: buildIntegral(edges),
  }
}

/** A template resolved at one specific size, with its gradient counterpart. */
export interface SizedTemplate {
  readonly size: number
  readonly alpha: AlphaMap
  readonly spatial: Template
  readonly gradient: Template
}

export function sizeTemplate(map: AlphaMap, size: number): SizedTemplate {
  const alpha = scaleAlphaMap(map, size, size)
  const spatialTemplate = templateFromAlphaMap(alpha)
  const edges = sobelMagnitude({ width: size, height: size, data: alpha.data })
  return {
    size,
    alpha,
    spatial: spatialTemplate,
    gradient: makeTemplate(edges.data, size, size),
  }
}

/**
 * Local contrast dampening, in `0..1`.
 *
 * Compositing white at alpha scales local contrast by about `(1 - alpha)`, so the
 * marked region is measurably flatter than what surrounds it. Expressed as a ratio of
 * standard deviations so it does not care how busy the scene is.
 */
export function varianceScore(ii: IntegralImage, rect: Rect, ringWidth = 6): number {
  const inside = patchStd(ii, rect)
  const outer: Rect = {
    x: Math.max(0, rect.x - ringWidth),
    y: Math.max(0, rect.y - ringWidth),
    width: 0,
    height: 0,
  }
  const x1 = Math.min(ii.width, rect.x + rect.width + ringWidth)
  const y1 = Math.min(ii.height, rect.y + rect.height + ringWidth)
  const surround = patchStd(ii, {
    x: outer.x,
    y: outer.y,
    width: x1 - outer.x,
    height: y1 - outer.y,
  })
  if (surround <= 1e-6) return 0
  return Math.max(0, Math.min(1, (surround - inside) / surround))
}

function patchStd(ii: IntegralImage, rect: Rect): number {
  const area = rect.width * rect.height
  if (area <= 0) return 0
  const sum = patchSum(ii, rect)
  const mean = sum / area
  return Math.sqrt(Math.max(0, patchSumSquares(ii, rect) / area - mean * mean))
}

/** Scores one position against one sized template. */
export function scoreAt(
  analysis: FrameAnalysis,
  template: SizedTemplate,
  x: number,
  y: number,
  kernel: CorrelationKernel = referenceKernel,
  weights: FusedWeights = DEFAULT_WEIGHTS
): Candidate {
  const rect: Rect = { x, y, width: template.size, height: template.size }

  // Magnitude, not signed score: the mark reads as a positive correlation on dark
  // backgrounds and a negative one on bright backgrounds.
  const spatial = Math.abs(kernel.score(analysis.image, analysis.integral, template.spatial, x, y))
  const gradient = Math.abs(
    kernel.score(analysis.edges, analysis.edgeIntegral, template.gradient, x, y)
  )
  const variance = varianceScore(analysis.integral, rect)

  return {
    rect,
    spatial,
    gradient,
    variance,
    score: weights.spatial * spatial + weights.gradient * gradient + weights.variance * variance,
  }
}

/** Box-filtered 2x downsample. Averaging first keeps the coarse pass from aliasing. */
export function downsample2(image: Grayscale): Grayscale {
  const width = Math.max(1, image.width >> 1)
  const height = Math.max(1, image.height >> 1)
  const data = new Float32Array(width * height)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x * 2
      const sy = y * 2
      const x1 = Math.min(sx + 1, image.width - 1)
      const y1 = Math.min(sy + 1, image.height - 1)
      data[y * width + x] =
        ((image.data[sy * image.width + sx] as number) +
          (image.data[sy * image.width + x1] as number) +
          (image.data[y1 * image.width + sx] as number) +
          (image.data[y1 * image.width + x1] as number)) /
        4
    }
  }
  return { width, height, data }
}

/**
 * Searches a bounded region at full resolution, trying every requested size.
 *
 * Used both to refine coarse peaks and, on its own, to follow an existing track from
 * frame to frame — which is why tracking costs almost nothing compared to sweeping.
 */
export function searchWindow(
  analysis: FrameAnalysis,
  templates: readonly SizedTemplate[],
  window: Rect,
  options: SearchOptions = {}
): Candidate | null {
  const kernel = options.kernel ?? referenceKernel
  const weights = options.weights ?? DEFAULT_WEIGHTS

  let best: Candidate | null = null
  for (const template of templates) {
    const maxX = Math.min(window.x + window.width, analysis.image.width - template.size)
    const maxY = Math.min(window.y + window.height, analysis.image.height - template.size)

    for (let y = Math.max(0, window.y); y <= maxY; y++) {
      for (let x = Math.max(0, window.x); x <= maxX; x++) {
        const candidate = scoreAt(analysis, template, x, y, kernel, weights)
        if (!best || candidate.score > best.score) best = candidate
      }
    }
  }
  return best
}

/**
 * Full-frame sweep.
 *
 * Correlating every position at every scale on a 1080p frame is billions of
 * operations. Searching a downsampled copy first cuts that by the square of the
 * factor, and only the surviving peaks are re-scored at full resolution — so the
 * expensive work happens at a handful of places rather than two million.
 */
export function sweepFrame(
  analysis: FrameAnalysis,
  map: AlphaMap,
  options: SearchOptions = {}
): Candidate[] {
  const {
    kernel = referenceKernel,
    weights = DEFAULT_WEIGHTS,
    threshold = DEFAULT_THRESHOLD,
    maxCandidates = 8,
    coarseFactor = 4,
    refineRadius = 6,
    maxOverlap = 0.3,
  } = options

  const sizes = options.sizes ?? defaultSizes(analysis.image.width, analysis.image.height)

  // Coarse pass on a downsampled copy. The factor is capped so that even the
  // smallest requested template stays large enough to correlate against.
  const smallestSize = Math.min(...sizes)
  const affordableFactor = Math.max(1, Math.floor(smallestSize / MIN_COARSE_TEMPLATE))

  let coarseImage = analysis.image
  let factor = 1
  while (
    factor * 2 <= Math.min(coarseFactor, affordableFactor) &&
    coarseImage.width > 32 &&
    coarseImage.height > 32
  ) {
    coarseImage = downsample2(coarseImage)
    factor *= 2
  }
  const coarse = factor === 1 ? analysis : analyseFrame(coarseImage)

  const peaks: Candidate[] = []
  for (const size of sizes) {
    const coarseSize = Math.max(MIN_COARSE_TEMPLATE, Math.round(size / factor))
    if (coarseSize + 1 >= Math.min(coarse.image.width, coarse.image.height)) continue
    const template = sizeTemplate(map, coarseSize)

    for (let y = 0; y <= coarse.image.height - coarseSize; y++) {
      for (let x = 0; x <= coarse.image.width - coarseSize; x++) {
        // Half threshold at the coarse level: downsampling blurs the mark, so scores
        // are systematically lower here. Being strict now loses real detections.
        const candidate = scoreAt(coarse, template, x, y, kernel, weights)
        if (candidate.score >= threshold * 0.5) {
          peaks.push({
            ...candidate,
            rect: { x: x * factor, y: y * factor, width: size, height: size },
          })
        }
      }
    }
  }

  // Refine the strongest coarse peaks at full resolution.
  const fullTemplates = sizes.map((size) => sizeTemplate(map, size))
  const refined: Candidate[] = []
  for (const peak of suppressOverlaps(peaks, maxOverlap).slice(0, maxCandidates * 4)) {
    const window: Rect = {
      x: peak.rect.x - refineRadius,
      y: peak.rect.y - refineRadius,
      width: refineRadius * 2,
      height: refineRadius * 2,
    }
    const best = searchWindow(analysis, fullTemplates, window, { kernel, weights })
    if (best && best.score >= threshold) refined.push(best)
  }

  return suppressOverlaps(refined, maxOverlap).slice(0, maxCandidates)
}

/**
 * Sizes to try when nothing is known about the frame.
 *
 * Centred on the generic corner prior and spread wide enough to cover the variation
 * seen between encoding profiles at the same resolution.
 */
export function defaultSizes(width: number, height: number): number[] {
  const base = Math.min(width, height) / 15
  const sizes = new Set<number>()
  for (const ratio of [0.7, 0.85, 1, 1.2, 1.45]) {
    sizes.add(Math.max(16, Math.round(base * ratio)))
  }
  return [...sizes].sort((a, b) => a - b)
}

/** Intersection over union of two rects. */
export function overlap(a: Rect, b: Rect): number {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const intersection = x * y
  if (intersection === 0) return 0
  return intersection / (a.width * a.height + b.width * b.height - intersection)
}

/** Greedy non-maximum suppression: keep the strongest, drop what overlaps it. */
export function suppressOverlaps(candidates: readonly Candidate[], maxOverlap: number): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score)
  const kept: Candidate[] = []
  for (const candidate of sorted) {
    if (kept.every((k) => overlap(k.rect, candidate.rect) <= maxOverlap)) kept.push(candidate)
  }
  return kept
}
