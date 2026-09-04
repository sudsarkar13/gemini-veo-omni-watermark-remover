import { MAX_ALPHA } from "./constants.ts"
import type { AlphaMap } from "./types.ts"

/**
 * Derives an alpha map from a template capture of the mark against a black ground.
 *
 * Because the mark is composited as pure white onto black, the captured pixel value
 * *is* the alpha, scaled to 0..255. We take max(R, G, B) rather than a luminance
 * average: the mark is achromatic, so the channels agree, and max is robust against
 * a single channel having been chroma-subsampled during capture.
 *
 * Templates are produced by frame-differencing watermark on/off transition pairs —
 * see docs/PLAN.md §2.
 */
export function alphaMapFromTemplate(
  rgb: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4 = 3
): AlphaMap {
  const expected = width * height * channels
  if (rgb.length !== expected) {
    throw new RangeError(
      `template is ${rgb.length} bytes but ${width}x${height}x${channels} needs ${expected}`
    )
  }

  const data = new Float32Array(width * height)
  for (let i = 0; i < data.length; i++) {
    const o = i * channels
    const max = Math.max(rgb[o] as number, rgb[o + 1] as number, rgb[o + 2] as number)
    data[i] = max / 255
  }
  return { width, height, data }
}

/**
 * Resamples an alpha map to a new size with bilinear interpolation.
 *
 * Templates are captured at a handful of fixed sizes but marks are scaled to the
 * output resolution, so the detector needs the template at arbitrary sizes. Nearest
 * neighbour would produce stair-stepped edges and leave a visible halo after removal.
 */
export function scaleAlphaMap(map: AlphaMap, width: number, height: number): AlphaMap {
  if (width <= 0 || height <= 0) {
    throw new RangeError(`target size must be positive, received ${width}x${height}`)
  }
  if (map.width === width && map.height === height) return map

  const data = new Float32Array(width * height)

  // Map destination centres back into source space so edges stay symmetric.
  const scaleX = map.width / width
  const scaleY = map.height / height

  for (let row = 0; row < height; row++) {
    const srcY = Math.min(map.height - 1, Math.max(0, (row + 0.5) * scaleY - 0.5))
    const y0 = Math.floor(srcY)
    const y1 = Math.min(y0 + 1, map.height - 1)
    const wy = srcY - y0

    for (let col = 0; col < width; col++) {
      const srcX = Math.min(map.width - 1, Math.max(0, (col + 0.5) * scaleX - 0.5))
      const x0 = Math.floor(srcX)
      const x1 = Math.min(x0 + 1, map.width - 1)
      const wx = srcX - x0

      const top =
        (map.data[y0 * map.width + x0] as number) * (1 - wx) +
        (map.data[y0 * map.width + x1] as number) * wx
      const bottom =
        (map.data[y1 * map.width + x0] as number) * (1 - wx) +
        (map.data[y1 * map.width + x1] as number) * wx

      data[row * width + col] = top * (1 - wy) + bottom * wy
    }
  }

  return { width, height, data }
}

/**
 * Returns a copy with `gain` applied and values clamped to the safe inversion range.
 *
 * Prefer passing `gain` to `unblend` during processing; this is for the detector,
 * which needs a concrete gained map to correlate against.
 */
export function withGain(map: AlphaMap, gain: number): AlphaMap {
  if (!Number.isFinite(gain) || gain <= 0) {
    throw new RangeError(`gain must be a positive finite number, received ${gain}`)
  }
  const data = new Float32Array(map.data.length)
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.min((map.data[i] as number) * gain, MAX_ALPHA)
  }
  return { width: map.width, height: map.height, data }
}

/** Largest alpha present. Used to reject empty or malformed templates. */
export function peakAlpha(map: AlphaMap): number {
  let peak = 0
  for (let i = 0; i < map.data.length; i++) {
    const v = map.data[i] as number
    if (v > peak) peak = v
  }
  return peak
}
