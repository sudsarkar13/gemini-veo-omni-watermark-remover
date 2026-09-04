import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { LOGO_VALUE } from "./constants.ts"
import type { Grayscale } from "./correlate.ts"
import type { AlphaMap, Rect } from "./types.ts"
import { verifyReversibility } from "./verify.ts"

/** Textured background — a flat one would make the ring statistics degenerate. */
function background(width: number, height: number): Grayscale {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = 90 + ((x * 13 + y * 7) % 40)
    }
  }
  return { width, height, data }
}

function diamond(size: number, peak: number): AlphaMap {
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

/** Composites the mark onto luminance exactly as Gemini would. */
function stamp(image: Grayscale, alpha: AlphaMap, rect: Rect, gain: number): void {
  for (let row = 0; row < rect.height; row++) {
    for (let col = 0; col < rect.width; col++) {
      const a = Math.min((alpha.data[row * alpha.width + col] as number) * gain, 0.99)
      const i = (rect.y + row) * image.width + rect.x + col
      image.data[i] = a * LOGO_VALUE + (1 - a) * (image.data[i] as number)
    }
  }
}

const RECT: Rect = { x: 40, y: 40, width: 24, height: 24 }

describe("verifyReversibility", () => {
  it("recognises a genuine composite and recovers its intensity", () => {
    const template = diamond(24, 0.8)
    const image = background(128, 128)
    stamp(image, template, RECT, 0.75)

    const result = verifyReversibility(image, template, RECT)

    assert.equal(result.isComposite, true, `residualZ was ${result.residualZ}`)
    assert.equal(result.inconclusive, false)
    assert.ok(
      Math.abs(result.gain - 0.75) < 0.15,
      `expected gain near 0.75, recovered ${result.gain}`
    )
  })

  it("recovers a range of intensities", () => {
    const template = diamond(24, 0.8)
    for (const trueGain of [0.3, 0.5, 0.9, 1.2]) {
      const image = background(128, 128)
      stamp(image, template, RECT, trueGain)
      const result = verifyReversibility(image, template, RECT)
      assert.equal(result.isComposite, true, `missed a composite at gain ${trueGain}`)
      assert.ok(
        Math.abs(result.gain - trueGain) < 0.2,
        `gain ${trueGain}: recovered ${result.gain}`
      )
    }
  })

  it("rejects a dark blob, which no intensity can explain", () => {
    // Unblending only ever subtracts white, so it cannot lift a region that is
    // darker than its surroundings. This is real content, not a composite.
    const template = diamond(24, 0.8)
    const image = background(128, 128)
    for (let row = 0; row < RECT.height; row++) {
      for (let col = 0; col < RECT.width; col++) {
        if ((template.data[row * 24 + col] as number) > 0) {
          image.data[(RECT.y + row) * 128 + RECT.x + col] = 10
        }
      }
    }

    const result = verifyReversibility(image, template, RECT)
    assert.equal(result.isComposite, false, `residualZ was ${result.residualZ}`)
    assert.ok(result.residualZ < 0, "a dark hole should read as over-subtracted")
  })

  it("rejects plain background with no mark present", () => {
    // Nothing was composited here, so no correction should reconcile a subtracted
    // patch with its neighbourhood — every gain punches a hole.
    const template = diamond(24, 0.8)
    const result = verifyReversibility(background(128, 128), template, RECT)
    assert.equal(result.isComposite, false, `residualZ was ${result.residualZ}`)
    // The specific reason matters: there is no lift, so there is nothing to remove.
    // Residual alone would pass here, because correcting by nothing is consistent.
    assert.ok(Math.abs(result.liftZ) < 0.75, `unexpected lift ${result.liftZ}`)
  })

  it("reports inconclusive rather than guessing when the ring is featureless", () => {
    // A perfectly uniform surround has zero variance, so "consistent with the
    // background" has no scale. Fabricating a verdict here creates false detections.
    const flat: Grayscale = { width: 64, height: 64, data: new Float32Array(64 * 64).fill(100) }
    const result = verifyReversibility(flat, diamond(16, 0.8), { x: 24, y: 24, width: 16, height: 16 })
    assert.equal(result.inconclusive, true)
    assert.equal(result.isComposite, false)
  })

  it("reports inconclusive when the candidate leaves too little ring to sample", () => {
    const tiny: Grayscale = { width: 8, height: 8, data: background(8, 8).data }
    const result = verifyReversibility(tiny, diamond(8, 0.8), { x: 0, y: 0, width: 8, height: 8 })
    assert.equal(result.inconclusive, true)
    assert.ok(result.ringSamples < 16)
  })

  it("scales its verdict to the busyness of the background", () => {
    // The z-score is expressed in ring standard deviations, so the same absolute
    // residual is judged more harshly against flat sky than against foliage.
    const template = diamond(24, 0.8)
    const busy: Grayscale = { width: 128, height: 128, data: new Float32Array(128 * 128) }
    for (let i = 0; i < busy.data.length; i++) busy.data[i] = 60 + ((i * 37) % 120)
    stamp(busy, template, RECT, 0.7)

    const result = verifyReversibility(busy, template, RECT)
    assert.ok(result.ringStd > 10, "fixture should have a busy surround")
    assert.equal(result.isComposite, true)
  })

  it("honours a stricter acceptance threshold", () => {
    const template = diamond(24, 0.8)
    const image = background(128, 128)
    stamp(image, template, RECT, 0.75)

    const strict = verifyReversibility(image, template, RECT, { acceptZScore: 0 })
    assert.equal(strict.isComposite, false, "nothing should pass a zero-tolerance gate")
  })

  it("rejects an invalid gain range", () => {
    assert.throws(
      () => verifyReversibility(background(64, 64), diamond(8, 0.5), { x: 8, y: 8, width: 8, height: 8 }, { minGain: 1, maxGain: 0.5 }),
      RangeError
    )
  })
})
