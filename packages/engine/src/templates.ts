import { alphaMapFromTemplate } from "./alpha-map.ts"
import { decodePpm } from "./ppm.ts"
import { VEO_DIAMOND_48_PPM_BASE64 } from "./template-data.ts"
import type { AlphaMap } from "./types.ts"

/**
 * Loading and generating watermark alpha templates.
 *
 * `veoDiamond48` is a real capture: the mark's alpha recovered from Veo 720p output
 * (docs/PLAN.md §2). It is the default everywhere, because the shape it encodes is the
 * thing the detector correlates against and the alpha it encodes is what removal
 * subtracts — an approximation of either produces a run that reports success and
 * leaves the mark on screen, which is precisely what the synthetic stand-in did.
 *
 * `syntheticDiamond` remains for tests that need a template with no provenance
 * attached. It is a stand-in, not a substitute: any threshold tuned against it means
 * nothing until it is re-checked against a capture.
 */

let cached: AlphaMap | null = null

/**
 * The measured mark, 48x48, peak alpha ~0.31.
 *
 * Parsed once and shared. The map is treated as immutable throughout the engine —
 * `scaleAlphaMap` and `withGain` both return new maps rather than writing into theirs.
 */
export function veoDiamond48(): AlphaMap {
  if (cached) return cached
  const binary = atob(VEO_DIAMOND_48_PPM_BASE64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  cached = loadTemplatePpm(bytes)
  return cached
}

/** The template used when the caller has not supplied one of their own. */
export function defaultTemplate(): AlphaMap {
  return veoDiamond48()
}

export function loadTemplatePpm(buffer: Uint8Array): AlphaMap {
  const frame = decodePpm(buffer)
  return alphaMapFromTemplate(frame.data, frame.width, frame.height, frame.channels)
}

/**
 * A diamond with linearly falling alpha — the mark's gross shape, nothing more.
 *
 * Real captures have soft anti-aliased edges and a characteristic interior structure
 * this does not reproduce.
 */
export function syntheticDiamond(size = 48, peak = 0.85): AlphaMap {
  const data = new Float32Array(size * size)
  const centre = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = (Math.abs(x - centre) + Math.abs(y - centre)) / centre
      data[y * size + x] = d >= 1 ? 0 : peak * (1 - d)
    }
  }
  return { width: size, height: size, data }
}
