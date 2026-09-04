import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { alphaMapFromTemplate, peakAlpha, scaleAlphaMap, withGain } from "./alpha-map.ts"
import { MAX_ALPHA } from "./constants.ts"
import type { AlphaMap } from "./types.ts"

describe("alphaMapFromTemplate", () => {
  it("reads alpha as the brightest channel over 255", () => {
    const rgb = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 128, 0, 0, 0, 64, 0])
    const map = alphaMapFromTemplate(rgb, 2, 2)
    assert.equal(map.data[0], 0)
    assert.equal(map.data[1], 1)
    // Float32Array narrows to 32-bit, so compare against the f32 value.
    assert.equal(map.data[2], Math.fround(128 / 255))
    assert.equal(map.data[3], Math.fround(64 / 255))
  })

  it("handles RGBA templates", () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255])
    const map = alphaMapFromTemplate(rgba, 2, 1, 4)
    assert.equal(map.data[0], 1)
    assert.equal(map.data[1], 0)
  })

  it("rejects a template whose byte length disagrees with its dimensions", () => {
    assert.throws(() => alphaMapFromTemplate(new Uint8ClampedArray(10), 2, 2), RangeError)
  })
})

describe("scaleAlphaMap", () => {
  const source: AlphaMap = {
    width: 2,
    height: 2,
    data: new Float32Array([0, 1, 1, 0]),
  }

  it("returns the same object when the size already matches", () => {
    assert.equal(scaleAlphaMap(source, 2, 2), source)
  })

  it("produces the requested dimensions", () => {
    const scaled = scaleAlphaMap(source, 7, 5)
    assert.equal(scaled.width, 7)
    assert.equal(scaled.height, 5)
    assert.equal(scaled.data.length, 35)
  })

  it("keeps every sample within the source range", () => {
    // Bilinear interpolation must not overshoot; an out-of-range alpha would make
    // 1/(1-alpha) explode during inversion.
    const scaled = scaleAlphaMap(source, 13, 13)
    for (const v of scaled.data) {
      assert.ok(v >= 0 && v <= 1, `sample ${v} escaped the 0..1 range`)
    }
  })

  it("preserves corner values when upscaling", () => {
    const scaled = scaleAlphaMap(source, 8, 8)
    assert.equal(scaled.data[0], 0)
    assert.equal(scaled.data[7], 1)
  })

  it("stays symmetric for a symmetric source", () => {
    const scaled = scaleAlphaMap(source, 9, 9)
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const here = scaled.data[y * 9 + x] as number
        const mirrored = scaled.data[y * 9 + (8 - x)] as number
        // Source is anti-symmetric across x, so mirroring x maps 0<->1 values.
        assert.ok(Math.abs(here + mirrored - 1) < 1e-6, `asymmetry at (${x},${y})`)
      }
    }
  })

  it("rejects a non-positive target size", () => {
    assert.throws(() => scaleAlphaMap(source, 0, 4), RangeError)
  })
})

describe("withGain", () => {
  it("scales every sample", () => {
    const map: AlphaMap = { width: 2, height: 1, data: new Float32Array([0.2, 0.4]) }
    const gained = withGain(map, 0.5)
    assert.ok(Math.abs((gained.data[0] as number) - 0.1) < 1e-6)
    assert.ok(Math.abs((gained.data[1] as number) - 0.2) < 1e-6)
  })

  it("clamps at MAX_ALPHA so inversion cannot divide by near-zero", () => {
    const map: AlphaMap = { width: 1, height: 1, data: new Float32Array([0.9]) }
    assert.equal(withGain(map, 2).data[0], Math.fround(MAX_ALPHA))
  })

  it("does not mutate the source", () => {
    const map: AlphaMap = { width: 1, height: 1, data: new Float32Array([0.5]) }
    withGain(map, 2)
    assert.equal(map.data[0], 0.5)
  })

  it("rejects a non-positive gain", () => {
    const map: AlphaMap = { width: 1, height: 1, data: new Float32Array([0.5]) }
    assert.throws(() => withGain(map, 0), RangeError)
  })
})

describe("peakAlpha", () => {
  it("finds the largest sample", () => {
    const map = { width: 3, height: 1, data: new Float32Array([0.1, 0.7, 0.3]) }
    assert.equal(peakAlpha(map), Math.fround(0.7))
  })

  it("returns zero for an empty template", () => {
    assert.equal(peakAlpha({ width: 2, height: 2, data: new Float32Array(4) }), 0)
  })
})
