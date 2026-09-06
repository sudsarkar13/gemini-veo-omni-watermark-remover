import { ALPHA_THRESHOLD } from "./constants.ts"
import { scaleAlphaMap } from "./alpha-map.ts"
import type { AlphaMap, Frame, Rect } from "./types.ts"

/**
 * Exemplar-based fill, for the regions reverse blending cannot serve.
 *
 * This is the one place in the engine that invents pixels, and it exists because the
 * alternative for those regions is leaving a visible watermark on the picture. It is
 * off unless asked for, it runs only where the exact path declined, and what it
 * touches is counted separately and never called "corrected". See `PLAN.md` §2.1.
 *
 * The method is Criminisi's: fill the hole a patch at a time, always choosing the
 * patch on the boundary where a strong edge runs into the hole, and filling it by
 * copying the most similar patch from the surrounding image. Two properties matter for
 * the content this tool is used on — engraved lettering, textured stone, star fields:
 *
 *   - It copies real patches, so texture stays texture. A diffusion fill (Telea,
 *     Navier-Stokes) solves a smoothness equation across the hole and produces a
 *     blurred smear, which on a lit engraved surface is instantly visible as damage.
 *   - Ordering by edge strength continues structure across the hole before flat areas
 *     are touched, so a line entering one side comes out the other.
 *
 * It is deterministic: the same frame and rectangle always produce the same pixels.
 * That matters for a tool whose output people compare frame to frame — a stochastic
 * fill would shimmer across a clip even where the content is static.
 */

export interface InpaintOptions {
  /**
   * Patch half-width; the patch is `(2r+1)` square.
   *
   * Small patches follow fine texture but wander on structure; large ones carry
   * structure but paste recognisable chunks of the image. Four is the usual
   * compromise and matches the scale of the mark's strokes.
   */
  readonly patchRadius?: number
  /**
   * How far outside the region to look for source patches, in pixels.
   *
   * The fill can only be as good as what is near it. Too small a margin and a mark on
   * a boundary has nothing to copy but the boundary; too large and the search cost
   * grows with the square while the patches stop being relevant.
   */
  readonly searchMargin?: number
  /** Alpha above which a template pixel counts as part of the mark. */
  readonly maskThreshold?: number
  /**
   * Pixels of slack added around the mark's footprint.
   *
   * The template's edge is soft, and the outermost ring of a composite is a mix of
   * mark and content that reverse blending would have unpicked. Filling a little wider
   * than the footprint costs nothing and avoids leaving a faint outline of the mark.
   */
  readonly dilation?: number
}

export interface InpaintReport {
  /** How many pixels were synthesised. Zero means nothing was in the mask. */
  readonly filled: number
  /** Patches copied. Useful as a sanity check on the fill's cost. */
  readonly patches: number
  /**
   * True when some masked pixels could not be filled because no usable source patch
   * existed — a region flush against the frame edge with nothing around it.
   */
  readonly incomplete: boolean
}

/**
 * Chosen by measurement, not by convention.
 *
 * A synthetic mark was stamped onto three regions of a real Veo frame and filled, then
 * compared against the untouched original. Mean absolute error per channel, against
 * 24.7 / 17.5 / 15.7 for leaving the mark in place:
 *
 *   patch/margin   black sky   lit rim   lettering   time
 *   r3 / m24         5.4        29.3       25.3      ~60ms
 *   r4 / m24         6.6        25.9       24.2      ~50ms
 *   r6 / m24         4.5        28.1       19.1      ~40ms
 *   r4 / m48         5.9        23.5       20.6      ~130ms
 *   r6 / m48         5.4        15.8       20.4      ~110ms   <-
 *   r8 / m64         6.5        17.7       24.9      ~180ms
 *
 * r6/m48 is the best of these on the hard cases and costs a tenth of a second. The
 * lettering row is the honest headline: on strongly structured content the fill is
 * still further from the truth than the watermark it replaces. See `PLAN.md` §2.1.
 */
const DEFAULTS = {
  patchRadius: 6,
  searchMargin: 48,
  maskThreshold: 0.05,
  dilation: 2,
} as const

export function inpaint(
  frame: Frame,
  template: AlphaMap,
  rect: Rect,
  options: InpaintOptions = {}
): InpaintReport {
  const patchRadius = Math.max(1, options.patchRadius ?? DEFAULTS.patchRadius)
  const searchMargin = Math.max(patchRadius * 2, options.searchMargin ?? DEFAULTS.searchMargin)
  const maskThreshold = Math.max(ALPHA_THRESHOLD, options.maskThreshold ?? DEFAULTS.maskThreshold)
  const dilation = Math.max(0, options.dilation ?? DEFAULTS.dilation)

  // The working window: the region plus everything the search may draw from. Clipped
  // to the frame, and everything below is in window coordinates.
  const x0 = Math.max(0, rect.x - searchMargin)
  const y0 = Math.max(0, rect.y - searchMargin)
  const x1 = Math.min(frame.width, rect.x + rect.width + searchMargin)
  const y1 = Math.min(frame.height, rect.y + rect.height + searchMargin)
  const width = x1 - x0
  const height = y1 - y0
  if (width <= 0 || height <= 0) return { filled: 0, patches: 0, incomplete: false }

  const alpha = scaleAlphaMap(template, rect.width, rect.height)
  const hole = buildMask(alpha, rect, { x0, y0, width, height }, maskThreshold, dilation)

  let remaining = 0
  for (const value of hole) if (value === 1) remaining++
  if (remaining === 0) return { filled: 0, patches: 0, incomplete: false }

  // Confidence: how trustworthy a pixel is as evidence. Source pixels are certain;
  // synthesised ones inherit the confidence of the patch that produced them, so the
  // fill works inward from the edges rather than trusting its own guesses equally.
  const confidence = new Float32Array(width * height)
  for (let i = 0; i < confidence.length; i++) confidence[i] = hole[i] === 1 ? 0 : 1

  // A copy of the original mask: source patches are taken only from pixels that were
  // known before any filling, so the fill cannot smear its own output across the hole.
  const source = new Uint8Array(hole.length)
  for (let i = 0; i < hole.length; i++) source[i] = hole[i] === 1 ? 0 : 1

  const luma = lumaOf(frame, x0, y0, width, height)

  let filled = 0
  let patches = 0
  let incomplete = false

  while (remaining > 0) {
    const target = highestPriority(hole, confidence, luma, width, height, patchRadius)
    if (target === -1) {
      incomplete = true
      break
    }

    const best = bestMatch(frame, hole, source, {
      x0,
      y0,
      width,
      height,
      target,
      patchRadius,
    })
    if (best === -1) {
      // Nothing to copy from: mark this pixel as unfillable so the loop makes
      // progress instead of choosing it again forever, and report the shortfall.
      hole[target] = 2
      remaining--
      incomplete = true
      continue
    }

    const copied = copyPatch(frame, hole, confidence, luma, {
      x0,
      y0,
      width,
      height,
      target,
      source: best,
      patchRadius,
    })
    filled += copied
    remaining -= copied
    patches++

    // A patch that copies nothing would loop forever; treat it as unfillable.
    if (copied === 0) {
      hole[target] = 2
      remaining--
      incomplete = true
    }
  }

  return { filled, patches, incomplete }
}

interface Window {
  readonly x0: number
  readonly y0: number
  readonly width: number
  readonly height: number
}

/**
 * The mask, in window coordinates: 1 where the mark is, 0 where the image is.
 *
 * Built from the template's own footprint rather than the whole rectangle, so the
 * corners of the box — which are ordinary content the mark never touched — are kept
 * rather than thrown away and re-invented.
 */
function buildMask(
  alpha: AlphaMap,
  rect: Rect,
  window: Window,
  threshold: number,
  dilation: number
): Uint8Array {
  const mask = new Uint8Array(window.width * window.height)

  for (let row = 0; row < rect.height; row++) {
    const y = rect.y + row - window.y0
    if (y < 0 || y >= window.height) continue
    for (let col = 0; col < rect.width; col++) {
      const x = rect.x + col - window.x0
      if (x < 0 || x >= window.width) continue
      if ((alpha.data[row * alpha.width + col] as number) >= threshold) {
        mask[y * window.width + x] = 1
      }
    }
  }

  for (let step = 0; step < dilation; step++) {
    const grown = mask.slice()
    for (let y = 0; y < window.height; y++) {
      for (let x = 0; x < window.width; x++) {
        if (mask[y * window.width + x] === 1) continue
        const up = y > 0 && mask[(y - 1) * window.width + x] === 1
        const down = y + 1 < window.height && mask[(y + 1) * window.width + x] === 1
        const left = x > 0 && mask[y * window.width + x - 1] === 1
        const right = x + 1 < window.width && mask[y * window.width + x + 1] === 1
        if (up || down || left || right) grown[y * window.width + x] = 1
      }
    }
    mask.set(grown)
  }

  return mask
}

/** Luminance of the window, kept separately because the priority terms only need it. */
function lumaOf(frame: Frame, x0: number, y0: number, width: number, height: number): Float32Array {
  const luma = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = ((y0 + y) * frame.width + (x0 + x)) * frame.channels
      luma[y * width + x] =
        0.299 * (frame.data[o] as number) +
        0.587 * (frame.data[o + 1] as number) +
        0.114 * (frame.data[o + 2] as number)
    }
  }
  return luma
}

/**
 * The next patch to fill: the boundary pixel where confidence and structure agree.
 *
 * Confidence alone fills from the outside in, which is safe and turns every hole into
 * an onion. The data term is what makes this worth doing — it is large where a strong
 * edge runs perpendicular to the boundary, so lines are continued into the hole first
 * and the flat areas are filled around them afterwards.
 */
function highestPriority(
  hole: Uint8Array,
  confidence: Float32Array,
  luma: Float32Array,
  width: number,
  height: number,
  patchRadius: number
): number {
  let best = -1
  let bestPriority = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      if (hole[index] !== 1) continue
      if (!onBoundary(hole, x, y, width, height)) continue

      // Mean confidence over the patch: how much of what this fill would rest on is
      // real image rather than earlier guesses.
      let sum = 0
      let count = 0
      for (let dy = -patchRadius; dy <= patchRadius; dy++) {
        const py = y + dy
        if (py < 0 || py >= height) continue
        for (let dx = -patchRadius; dx <= patchRadius; dx++) {
          const px = x + dx
          if (px < 0 || px >= width) continue
          sum += confidence[py * width + px] as number
          count++
        }
      }
      const term = count > 0 ? sum / count : 0

      const priority = term * (0.02 + dataTerm(hole, luma, x, y, width, height))
      if (priority > bestPriority) {
        bestPriority = priority
        best = index
      }
    }
  }

  return best
}

function onBoundary(hole: Uint8Array, x: number, y: number, width: number, height: number): boolean {
  if (y > 0 && hole[(y - 1) * width + x] === 0) return true
  if (y + 1 < height && hole[(y + 1) * width + x] === 0) return true
  if (x > 0 && hole[y * width + x - 1] === 0) return true
  if (x + 1 < width && hole[y * width + x + 1] === 0) return true
  return false
}

/**
 * How strongly an edge meets the boundary here, in 0..1.
 *
 * The isophote is the image gradient turned through a right angle — the direction
 * along which brightness *does not* change, which is the direction a line runs. Its
 * size against the boundary normal is large exactly where a line is about to be cut
 * off by the hole, which is where filling should start.
 */
function dataTerm(
  hole: Uint8Array,
  luma: Float32Array,
  x: number,
  y: number,
  width: number,
  height: number
): number {
  const at = (px: number, py: number): number | null => {
    if (px < 0 || px >= width || py < 0 || py >= height) return null
    const index = py * width + px
    // Only known pixels carry a gradient worth reading.
    return hole[index] === 0 ? (luma[index] as number) : null
  }

  const left = at(x - 1, y)
  const right = at(x + 1, y)
  const up = at(x, y - 1)
  const down = at(x, y + 1)

  const gx = left !== null && right !== null ? (right - left) / 2 : 0
  const gy = up !== null && down !== null ? (down - up) / 2 : 0

  // Boundary normal, from the mask itself: which way is out of the hole.
  const nx = (hole[y * width + Math.min(width - 1, x + 1)] === 1 ? 0 : 1) -
    (hole[y * width + Math.max(0, x - 1)] === 1 ? 0 : 1)
  const ny = (hole[Math.min(height - 1, y + 1) * width + x] === 1 ? 0 : 1) -
    (hole[Math.max(0, y - 1) * width + x] === 1 ? 0 : 1)
  const normal = Math.hypot(nx, ny)
  if (normal === 0) return 0

  // Isophote is the gradient rotated by 90 degrees: (-gy, gx).
  const dot = Math.abs((-gy * nx + gx * ny) / normal)
  return Math.min(1, dot / 255)
}

interface PatchContext extends Window {
  readonly target: number
  readonly patchRadius: number
}

/**
 * The most similar fully-known patch, compared over the pixels the target already has.
 *
 * Sum of squared differences across all three channels. Comparing only the known
 * pixels is what makes this work at all: the unknown ones are exactly what we are
 * asking the source patch to supply.
 */
function bestMatch(
  frame: Frame,
  hole: Uint8Array,
  source: Uint8Array,
  context: PatchContext
): number {
  const { x0, y0, width, height, target, patchRadius } = context
  const tx = target % width
  const ty = Math.floor(target / width)

  let best = -1
  let bestScore = Number.POSITIVE_INFINITY

  for (let cy = patchRadius; cy < height - patchRadius; cy++) {
    for (let cx = patchRadius; cx < width - patchRadius; cx++) {
      // The candidate must be entirely original image, or the fill would copy its own
      // output and drift.
      if (!fullyKnown(source, cx, cy, width, patchRadius)) continue

      let score = 0
      let compared = 0
      for (let dy = -patchRadius; dy <= patchRadius && score < bestScore; dy++) {
        const py = ty + dy
        if (py < 0 || py >= height) continue
        for (let dx = -patchRadius; dx <= patchRadius; dx++) {
          const px = tx + dx
          if (px < 0 || px >= width) continue
          if (hole[py * width + px] !== 0) continue

          const a = ((y0 + py) * frame.width + (x0 + px)) * frame.channels
          const b = ((y0 + cy + dy) * frame.width + (x0 + cx + dx)) * frame.channels
          const dr = (frame.data[a] as number) - (frame.data[b] as number)
          const dg = (frame.data[a + 1] as number) - (frame.data[b + 1] as number)
          const db = (frame.data[a + 2] as number) - (frame.data[b + 2] as number)
          score += dr * dr + dg * dg + db * db
          compared++
        }
      }

      if (compared === 0) continue
      // Normalised, so a patch overlapping the frame edge is not preferred merely for
      // having fewer pixels to disagree about.
      const normalised = score / compared
      if (normalised < bestScore) {
        bestScore = normalised
        best = cy * width + cx
      }
    }
  }

  return best
}

function fullyKnown(
  source: Uint8Array,
  cx: number,
  cy: number,
  width: number,
  patchRadius: number
): boolean {
  for (let dy = -patchRadius; dy <= patchRadius; dy++) {
    const row = (cy + dy) * width
    for (let dx = -patchRadius; dx <= patchRadius; dx++) {
      if (source[row + cx + dx] !== 1) return false
    }
  }
  return true
}

/** Copies the unknown pixels of the target patch from the chosen source patch. */
function copyPatch(
  frame: Frame,
  hole: Uint8Array,
  confidence: Float32Array,
  luma: Float32Array,
  context: PatchContext & { readonly source: number }
): number {
  const { x0, y0, width, height, target, source, patchRadius } = context
  const tx = target % width
  const ty = Math.floor(target / width)
  const sx = source % width
  const sy = Math.floor(source / width)

  // Every pixel this patch fills inherits the confidence of the patch centre, which is
  // what makes later fills prefer to build on earlier, better-supported ones.
  const inherited = confidence[target] as number
  let patchConfidence = 0
  let counted = 0
  for (let dy = -patchRadius; dy <= patchRadius; dy++) {
    const py = ty + dy
    if (py < 0 || py >= height) continue
    for (let dx = -patchRadius; dx <= patchRadius; dx++) {
      const px = tx + dx
      if (px < 0 || px >= width) continue
      patchConfidence += confidence[py * width + px] as number
      counted++
    }
  }
  const assigned = counted > 0 ? patchConfidence / counted : inherited

  let copied = 0
  for (let dy = -patchRadius; dy <= patchRadius; dy++) {
    const py = ty + dy
    if (py < 0 || py >= height) continue
    for (let dx = -patchRadius; dx <= patchRadius; dx++) {
      const px = tx + dx
      if (px < 0 || px >= width) continue
      const index = py * width + px
      if (hole[index] !== 1) continue

      const to = ((y0 + py) * frame.width + (x0 + px)) * frame.channels
      const from = ((y0 + sy + dy) * frame.width + (x0 + sx + dx)) * frame.channels
      frame.data[to] = frame.data[from] as number
      frame.data[to + 1] = frame.data[from + 1] as number
      frame.data[to + 2] = frame.data[from + 2] as number
      // The fourth channel, where there is one, is transparency and is not ours.

      luma[index] =
        0.299 * (frame.data[to] as number) +
        0.587 * (frame.data[to + 1] as number) +
        0.114 * (frame.data[to + 2] as number)
      hole[index] = 0
      confidence[index] = assigned
      copied++
    }
  }

  return copied
}
