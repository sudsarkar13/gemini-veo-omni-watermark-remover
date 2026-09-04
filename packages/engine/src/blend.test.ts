import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { blend, unblend } from "./blend.ts"
import { ALPHA_THRESHOLD, LOGO_VALUE } from "./constants.ts"
import type { AlphaMap, Frame, Rect } from "./types.ts"

/** Deterministic, texture-rich content so errors cannot hide in flat regions. */
function makeFrame(width: number, height: number, channels: 3 | 4 = 3): Frame {
  const data = new Uint8ClampedArray(width * height * channels)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels
      data[o] = (x * 7 + y * 3) % 256
      data[o + 1] = (x * 13 + y * 29) % 256
      data[o + 2] = ((x ^ y) * 11) % 256
      if (channels === 4) data[o + 3] = 255
    }
  }
  return { width, height, channels, data }
}

/** A diamond, echoing the real mark's shape, with alpha peaking at `peak`. */
function makeDiamond(size: number, peak: number): AlphaMap {
  const data = new Float32Array(size * size)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = (Math.abs(x - c) + Math.abs(y - c)) / c
      data[y * size + x] = d >= 1 ? 0 : peak * (1 - d)
    }
  }
  return { width: size, height: size, data }
}

describe("unblend", () => {
  it("recovers the original after a forward composite (round trip)", () => {
    const frame = makeFrame(64, 64)
    const original = Uint8ClampedArray.from(frame.data)
    const alpha = makeDiamond(32, 0.8)
    const region: Rect = { x: 16, y: 16, width: 32, height: 32 }

    blend(frame, alpha, region)
    assert.notDeepEqual(frame.data, original, "composite should have changed pixels")

    unblend(frame, alpha, region)

    // The forward pass quantises to 8 bits, and inversion amplifies that error by
    // 1/(1-alpha). Tolerance is derived from the alpha actually used, not guessed.
    for (let row = 0; row < region.height; row++) {
      for (let col = 0; col < region.width; col++) {
        const a = alpha.data[row * alpha.width + col] as number
        if (a < ALPHA_THRESHOLD) continue
        const i = ((region.y + row) * frame.width + region.x + col) * frame.channels
        const tolerance = 0.5 / (1 - a) + 1
        for (let c = 0; c < 3; c++) {
          const got = frame.data[i + c] as number
          const want = original[i + c] as number
          assert.ok(
            Math.abs(got - want) <= tolerance,
            `pixel (${col},${row}) ch${c}: got ${got}, want ${want}, tolerance ${tolerance.toFixed(2)}`
          )
        }
      }
    }
  })

  it("recovers exactly where the composite did not quantise", () => {
    // Chosen so the composite lands on a whole number and loses nothing:
    //   0.5 * 255 + 0.5 * 101 = 127.5 + 50.5 = 178.0 exactly.
    // With any 8-bit rounding at all, inversion amplifies the error by 1/(1-alpha),
    // which is what the round-trip test above measures. Here there is no error to
    // amplify, so recovery must be bit-exact.
    const VALUE = 101
    const frame: Frame = {
      width: 1,
      height: 1,
      channels: 3,
      data: new Uint8ClampedArray([VALUE, VALUE, VALUE]),
    }
    const alpha: AlphaMap = { width: 1, height: 1, data: new Float32Array([0.5]) }
    const region: Rect = { x: 0, y: 0, width: 1, height: 1 }

    blend(frame, alpha, region)
    assert.equal(frame.data[0], 0.5 * LOGO_VALUE + 0.5 * VALUE)

    unblend(frame, alpha, region)
    assert.equal(frame.data[0], VALUE)
  })

  it("leaves pixels below the alpha threshold untouched", () => {
    const frame = makeFrame(8, 8)
    const original = Uint8ClampedArray.from(frame.data)
    const alpha: AlphaMap = {
      width: 8,
      height: 8,
      data: new Float32Array(64).fill(ALPHA_THRESHOLD / 2),
    }

    unblend(frame, alpha, { x: 0, y: 0, width: 8, height: 8 })
    assert.deepEqual(frame.data, original)
  })

  it("never writes outside the region", () => {
    const frame = makeFrame(32, 32)
    const original = Uint8ClampedArray.from(frame.data)
    const alpha = makeDiamond(8, 0.9)
    const region: Rect = { x: 10, y: 10, width: 8, height: 8 }

    unblend(frame, alpha, region)

    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const inside = x >= 10 && x < 18 && y >= 10 && y < 18
        if (inside) continue
        const i = (y * 32 + x) * 3
        for (let c = 0; c < 3; c++) {
          assert.equal(frame.data[i + c], original[i + c], `pixel (${x},${y}) was modified`)
        }
      }
    }
  })

  it("clips a region that hangs off the frame edge", () => {
    const frame = makeFrame(16, 16)
    const alpha = makeDiamond(8, 0.5)
    // Bottom-right corner: half the region is outside the frame.
    assert.doesNotThrow(() => unblend(frame, alpha, { x: 12, y: 12, width: 8, height: 8 }))
  })

  it("preserves the alpha channel of RGBA frames", () => {
    const frame = makeFrame(16, 16, 4)
    for (let i = 3; i < frame.data.length; i += 4) frame.data[i] = 128
    const alpha = makeDiamond(16, 0.7)

    unblend(frame, alpha, { x: 0, y: 0, width: 16, height: 16 })

    for (let i = 3; i < frame.data.length; i += 4) {
      assert.equal(frame.data[i], 128, "alpha channel must not be touched")
    }
  })

  it("applies gain to every alpha sample", () => {
    const build = (): Frame => ({
      width: 1,
      height: 1,
      channels: 3,
      data: new Uint8ClampedArray([200, 200, 200]),
    })
    const alpha: AlphaMap = { width: 1, height: 1, data: new Float32Array([0.5]) }
    const region: Rect = { x: 0, y: 0, width: 1, height: 1 }

    const plain = build()
    unblend(plain, alpha, region)
    const gained = build()
    unblend(gained, alpha, region, { gain: 0.6 })

    // Lower effective alpha subtracts less of the white logo, so more signal survives.
    assert.ok(
      (gained.data[0] as number) > (plain.data[0] as number),
      "gain < 1 should remove less"
    )
  })

  it("rejects a mismatched alpha map rather than corrupting the frame", () => {
    const frame = makeFrame(16, 16)
    const alpha = makeDiamond(8, 0.5)
    assert.throws(
      () => unblend(frame, alpha, { x: 0, y: 0, width: 16, height: 16 }),
      /scale the map first/
    )
  })

  it("rejects a non-positive gain", () => {
    const frame = makeFrame(8, 8)
    const alpha = makeDiamond(8, 0.5)
    const region: Rect = { x: 0, y: 0, width: 8, height: 8 }
    assert.throws(() => unblend(frame, alpha, region, { gain: 0 }), RangeError)
    assert.throws(() => unblend(frame, alpha, region, { gain: -1 }), RangeError)
    assert.throws(() => unblend(frame, alpha, region, { gain: NaN }), RangeError)
  })
})
