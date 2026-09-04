import { ALPHA_THRESHOLD, LOGO_VALUE, MAX_ALPHA } from "./constants.ts"
import type { AlphaMap, BlendOptions, Frame, Rect } from "./types.ts"

/**
 * Reverse alpha blending — the core of the engine.
 *
 * Gemini composites the mark as:
 *
 *     watermarked = alpha * logo + (1 - alpha) * original
 *
 * which inverts exactly to:
 *
 *     original = (watermarked - alpha * logo) / (1 - alpha)
 *
 * This is recovery, not restoration: no blur, no crop, no inpainting, no guessing.
 * The only irrecoverable case is a pixel that clipped at 255 under the mark, where
 * the original value is genuinely gone.
 *
 * Mutates `frame.data` in place over `region`. Pixels outside the frame are skipped,
 * so a region may safely hang off an edge.
 */
export function unblend(
  frame: Frame,
  alpha: AlphaMap,
  region: Rect,
  options: BlendOptions = {}
): void {
  const gain = options.gain ?? 1
  forEachAlphaPixel(frame, alpha, region, gain, (data, index, a) => {
    const oneMinusAlpha = 1 - a
    for (let c = 0; c < 3; c++) {
      const watermarked = data[index + c] as number
      data[index + c] = (watermarked - a * LOGO_VALUE) / oneMinusAlpha
    }
  })
}

/**
 * Forward alpha blending — composites the mark back on.
 *
 * This exists for two real reasons, not symmetry: it generates ground-truth fixtures
 * for the round-trip tests, and the reversibility verifier (docs/PLAN.md §4) needs to
 * model the composite in order to decide whether a candidate region is one.
 */
export function blend(
  frame: Frame,
  alpha: AlphaMap,
  region: Rect,
  options: BlendOptions = {}
): void {
  const gain = options.gain ?? 1
  forEachAlphaPixel(frame, alpha, region, gain, (data, index, a) => {
    for (let c = 0; c < 3; c++) {
      const original = data[index + c] as number
      data[index + c] = a * LOGO_VALUE + (1 - a) * original
    }
  })
}

/**
 * Walks the intersection of `region` and the frame, resolving each alpha sample and
 * skipping pixels whose alpha is below the noise floor.
 *
 * The callback receives a raw byte index so it can write all three channels without
 * recomputing the offset. `Uint8ClampedArray` handles clamping and rounding for us.
 */
function forEachAlphaPixel(
  frame: Frame,
  alpha: AlphaMap,
  region: Rect,
  gain: number,
  apply: (data: Uint8ClampedArray, index: number, alpha: number) => void
): void {
  if (!Number.isFinite(gain) || gain <= 0) {
    throw new RangeError(`gain must be a positive finite number, received ${gain}`)
  }
  if (alpha.width !== region.width || alpha.height !== region.height) {
    throw new RangeError(
      `alpha map is ${alpha.width}x${alpha.height} but region is ` +
        `${region.width}x${region.height}; scale the map first`
    )
  }

  const { data, width: frameWidth, height: frameHeight, channels } = frame

  // Clip once up front rather than testing bounds per pixel.
  const startRow = Math.max(0, -region.y)
  const endRow = Math.min(region.height, frameHeight - region.y)
  const startCol = Math.max(0, -region.x)
  const endCol = Math.min(region.width, frameWidth - region.x)

  for (let row = startRow; row < endRow; row++) {
    const frameRowOffset = (region.y + row) * frameWidth
    const alphaRowOffset = row * alpha.width

    for (let col = startCol; col < endCol; col++) {
      let a = (alpha.data[alphaRowOffset + col] as number) * gain
      if (a < ALPHA_THRESHOLD) continue
      if (a > MAX_ALPHA) a = MAX_ALPHA

      apply(data, (frameRowOffset + region.x + col) * channels, a)
    }
  }
}
