import type { AlphaMap, Frame, Rect } from "./types.ts"

/**
 * Normalised cross-correlation, and the image statistics it needs.
 *
 * NCC answers "how well does this template match this patch", normalised for local
 * brightness and contrast so a match scores the same on a dark frame as a bright one.
 * Raw correlation would simply fire on whichever region is brightest.
 *
 * The naive formulation recomputes the patch mean and variance at every candidate
 * position, which is O(k^2) per position on top of the O(k^2) cross term. Summed-area
 * tables reduce those statistics to O(1) lookups, which is the difference between a
 * full-frame sweep taking seconds and taking minutes.
 */

/** Single-channel image in floating point, row-major. */
export interface Grayscale {
  readonly width: number
  readonly height: number
  readonly data: Float32Array
}

/**
 * Summed-area tables over an image and its squares.
 *
 * Both are `(width + 1) * (height + 1)` with a zero first row and column, so a patch
 * sum is four lookups with no bounds special-casing. Float64 because these accumulate
 * across the whole image and Float32 would lose precision on large frames.
 */
export interface IntegralImage {
  readonly width: number
  readonly height: number
  readonly sum: Float64Array
  readonly sumSq: Float64Array
}

/** A pre-analysed correlation template. Mean and variance are computed once. */
export interface Template {
  readonly width: number
  readonly height: number
  /** Zero-mean template values, so the cross term is a plain dot product. */
  readonly centred: Float32Array
  /** sqrt(sum((T - mean)^2)). Zero for a flat template, which cannot be matched. */
  readonly norm: number
}

/**
 * The correlation kernel is isolated behind this interface so it can be replaced with
 * a WASM/SIMD implementation without the detector or tracker knowing (AGENTS.md).
 */
export interface CorrelationKernel {
  readonly id: string
  score(
    image: Grayscale,
    integral: IntegralImage,
    template: Template,
    x: number,
    y: number
  ): number
}

/** Rec. 709 luma. The mark is achromatic, so luminance carries all of its signal. */
export function toGrayscale(frame: Frame): Grayscale {
  const { width, height, channels, data } = frame
  const out = new Float32Array(width * height)
  for (let i = 0; i < out.length; i++) {
    const o = i * channels
    out[i] =
      0.2126 * (data[o] as number) +
      0.7152 * (data[o + 1] as number) +
      0.0722 * (data[o + 2] as number)
  }
  return { width, height, data: out }
}

export function buildIntegral(image: Grayscale): IntegralImage {
  const { width, height, data } = image
  const stride = width + 1
  const sum = new Float64Array(stride * (height + 1))
  const sumSq = new Float64Array(stride * (height + 1))

  for (let y = 0; y < height; y++) {
    let rowSum = 0
    let rowSumSq = 0
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x] as number
      rowSum += v
      rowSumSq += v * v
      const i = (y + 1) * stride + (x + 1)
      sum[i] = (sum[i - stride] as number) + rowSum
      sumSq[i] = (sumSq[i - stride] as number) + rowSumSq
    }
  }
  return { width, height, sum, sumSq }
}

function areaSum(table: Float64Array, stride: number, rect: Rect): number {
  const { x, y, width: w, height: h } = rect
  const top = y * stride
  const bottom = (y + h) * stride
  return (
    (table[bottom + x + w] as number) -
    (table[top + x + w] as number) -
    (table[bottom + x] as number) +
    (table[top + x] as number)
  )
}

/** Sum of pixel values over a patch. O(1). */
export function patchSum(ii: IntegralImage, rect: Rect): number {
  return areaSum(ii.sum, ii.width + 1, rect)
}

/** Sum of squared pixel values over a patch. O(1). */
export function patchSumSquares(ii: IntegralImage, rect: Rect): number {
  return areaSum(ii.sumSq, ii.width + 1, rect)
}

export function makeTemplate(data: Float32Array, width: number, height: number): Template {
  if (data.length !== width * height) {
    throw new RangeError(`template data is ${data.length} but ${width}x${height} needs ${width * height}`)
  }
  let total = 0
  for (let i = 0; i < data.length; i++) total += data[i] as number
  const mean = total / data.length

  const centred = new Float32Array(data.length)
  let sumSq = 0
  for (let i = 0; i < data.length; i++) {
    const c = (data[i] as number) - mean
    centred[i] = c
    sumSq += c * c
  }
  return { width, height, centred, norm: Math.sqrt(sumSq) }
}

/**
 * Builds a correlation template from a watermark alpha map.
 *
 * The alpha map *is* the mark's shape, so it correlates directly. The absolute alpha
 * scale is irrelevant — NCC normalises it away — which is why detection does not need
 * to know the intensity in advance. Finding the mark and measuring its strength are
 * separate problems, solved by the detector and the verifier respectively.
 */
export function templateFromAlphaMap(map: AlphaMap): Template {
  return makeTemplate(map.data, map.width, map.height)
}

/**
 * Sobel gradient magnitude.
 *
 * The diamond has hard edges, and edge structure survives compression and background
 * variation better than absolute intensity — which is why the fused detector weights
 * a gradient-domain match alongside the spatial one.
 */
export function sobelMagnitude(image: Grayscale): Grayscale {
  const { width, height, data } = image
  const out = new Float32Array(width * height)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const tl = data[i - width - 1] as number
      const tc = data[i - width] as number
      const tr = data[i - width + 1] as number
      const ml = data[i - 1] as number
      const mr = data[i + 1] as number
      const bl = data[i + width - 1] as number
      const bc = data[i + width] as number
      const br = data[i + width + 1] as number

      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl)
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr)
      out[i] = Math.hypot(gx, gy)
    }
  }
  return { width, height, data: out }
}

/**
 * Reference NCC implementation.
 *
 * Returns a score in `[-1, 1]`, or 0 where correlation is undefined — a flat template
 * or a perfectly uniform patch, neither of which can be matched meaningfully.
 *
 * Callers that need polarity invariance should take the absolute value: the mark
 * brightens the frame, so against a bright background the correlation flips sign
 * while still indicating a genuine match.
 */
export const referenceKernel: CorrelationKernel = {
  id: "reference-js",
  score(image, integral, template, x, y) {
    const { width: tw, height: th, centred, norm } = template
    if (norm === 0) return 0
    if (x < 0 || y < 0 || x + tw > image.width || y + th > image.height) return 0

    const area = tw * th
    const rect: Rect = { x, y, width: tw, height: th }
    const sum = patchSum(integral, rect)
    const sumSq = patchSumSquares(integral, rect)

    // sum((I - mean)^2) = sum(I^2) - n * mean^2, from the integral tables.
    const patchVariance = sumSq - (sum * sum) / area
    if (patchVariance <= 1e-9) return 0

    // Because the template is zero-mean, sum((I - Ī)(T - T̄)) collapses to sum(I * T'),
    // so the patch mean drops out of the cross term entirely.
    let cross = 0
    for (let row = 0; row < th; row++) {
      let imageIndex = (y + row) * image.width + x
      let templateIndex = row * tw
      for (let col = 0; col < tw; col++) {
        cross += (image.data[imageIndex++] as number) * (centred[templateIndex++] as number)
      }
    }

    return cross / (Math.sqrt(patchVariance) * norm)
  },
}
