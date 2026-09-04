import { alphaMapFromTemplate } from "./alpha-map.ts"
import { decodePpm } from "./ppm.ts"
import type { AlphaMap } from "./types.ts"

/**
 * Loading and generating watermark alpha templates.
 *
 * The real templates are captures of the mark against black, derived by
 * frame-differencing watermark on/off transition pairs (docs/PLAN.md §2). Until those
 * are in the repository, `syntheticDiamond` provides a stand-in with the right gross
 * shape so the pipeline can be exercised end to end.
 *
 * It is a stand-in, not a substitute. Detection thresholds tuned against it mean
 * nothing until they are re-checked against a real capture.
 */

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
