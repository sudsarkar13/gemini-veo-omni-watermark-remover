import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

import { peakAlpha } from "./alpha-map.ts"
import { VEO_DIAMOND_48_PPM_BASE64 } from "./template-data.ts"
import { defaultTemplate, syntheticDiamond, veoDiamond48 } from "./templates.ts"

const ASSET = fileURLToPath(new URL("../assets/veo-diamond-48.ppm", import.meta.url))

describe("veoDiamond48", () => {
  it("is byte-identical to the asset it was generated from", async () => {
    // The asset is the artifact you inspect and regenerate; the embedded copy is what
    // ships. If they drift, the shipped template is no longer the measured one and
    // its provenance comment becomes a lie.
    const onDisk = await readFile(ASSET)
    const embedded = Buffer.from(VEO_DIAMOND_48_PPM_BASE64, "base64")
    assert.deepEqual(embedded, onDisk)
  })

  it("carries the measured geometry and intensity", () => {
    const map = veoDiamond48()
    assert.equal(map.width, 48)
    assert.equal(map.height, 48)
    // Measured from Veo 720p output; a template that has drifted far from this is
    // no longer the thing that was calibrated.
    assert.ok(
      Math.abs(peakAlpha(map) - 0.31) < 0.03,
      `expected a peak alpha near 0.31, found ${peakAlpha(map)}`
    )
  })

  it("has a clear interior and empty corners", () => {
    const map = veoDiamond48()
    const at = (x: number, y: number): number => map.data[y * map.width + x] as number
    assert.ok(at(24, 24) > 0.25, "the centre of the mark should be solid")
    for (const [x, y] of [
      [0, 0],
      [47, 0],
      [0, 47],
      [47, 47],
    ] as const) {
      assert.ok(at(x, y) < 0.02, `corner ${x},${y} should be empty, was ${at(x, y)}`)
    }
  })

  it("is the default, and is shared rather than re-parsed", () => {
    assert.equal(defaultTemplate(), veoDiamond48())
  })

  it("is not the synthetic stand-in", () => {
    // The stand-in exists for fixtures with no provenance. Shipping it by accident is
    // exactly the failure this file guards against.
    const real = veoDiamond48()
    const fake = syntheticDiamond(48)
    assert.notEqual(peakAlpha(real).toFixed(2), peakAlpha(fake).toFixed(2))
  })
})
