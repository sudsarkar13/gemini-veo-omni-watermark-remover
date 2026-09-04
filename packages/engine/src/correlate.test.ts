import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildIntegral,
  makeTemplate,
  patchSum,
  patchSumSquares,
  referenceKernel,
  sobelMagnitude,
  templateFromAlphaMap,
  toGrayscale,
  type Grayscale,
} from "./correlate.ts"
import type { AlphaMap, Frame } from "./types.ts"

function gray(width: number, height: number, fn: (x: number, y: number) => number): Grayscale {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = fn(x, y)
  }
  return { width, height, data }
}

/** Independent O(n) implementation to check the integral tables against. */
function bruteSum(image: Grayscale, x: number, y: number, w: number, h: number): number {
  let total = 0
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) total += image.data[row * image.width + col] as number
  }
  return total
}

describe("toGrayscale", () => {
  it("applies Rec. 709 luma weights", () => {
    const frame: Frame = {
      width: 1,
      height: 1,
      channels: 3,
      data: new Uint8ClampedArray([255, 0, 0]),
    }
    assert.ok(Math.abs((toGrayscale(frame).data[0] as number) - 0.2126 * 255) < 1e-3)
  })

  it("ignores the alpha channel of RGBA frames", () => {
    const rgb: Frame = { width: 1, height: 1, channels: 3, data: new Uint8ClampedArray([10, 20, 30]) }
    const rgba: Frame = {
      width: 1,
      height: 1,
      channels: 4,
      data: new Uint8ClampedArray([10, 20, 30, 7]),
    }
    assert.equal(toGrayscale(rgb).data[0], toGrayscale(rgba).data[0])
  })
})

describe("integral images", () => {
  const image = gray(23, 17, (x, y) => (x * 3 + y * 7) % 31)
  const ii = buildIntegral(image)

  it("matches a brute-force sum over arbitrary patches", () => {
    for (const rect of [
      { x: 0, y: 0, width: 23, height: 17 },
      { x: 5, y: 3, width: 8, height: 9 },
      { x: 22, y: 16, width: 1, height: 1 },
      { x: 0, y: 0, width: 1, height: 17 },
    ]) {
      const expected = bruteSum(image, rect.x, rect.y, rect.width, rect.height)
      assert.ok(Math.abs(patchSum(ii, rect) - expected) < 1e-6, `sum mismatch at ${JSON.stringify(rect)}`)
    }
  })

  it("matches a brute-force sum of squares", () => {
    const rect = { x: 4, y: 2, width: 10, height: 6 }
    let expected = 0
    for (let row = rect.y; row < rect.y + rect.height; row++) {
      for (let col = rect.x; col < rect.x + rect.width; col++) {
        const v = image.data[row * image.width + col] as number
        expected += v * v
      }
    }
    assert.ok(Math.abs(patchSumSquares(ii, rect) - expected) < 1e-6)
  })
})

describe("referenceKernel", () => {
  // An asymmetric, textured patch: a flat or symmetric one would match trivially.
  const pattern = (x: number, y: number) => (x * 17 + y * 41) % 97

  it("scores a perfect match as 1", () => {
    const image = gray(16, 16, pattern)
    const template = makeTemplate(gray(16, 16, pattern).data, 16, 16)
    const score = referenceKernel.score(image, buildIntegral(image), template, 0, 0)
    assert.ok(Math.abs(score - 1) < 1e-5, `expected ~1, got ${score}`)
  })

  it("scores an inverted match as -1, which is why callers take the absolute value", () => {
    const image = gray(16, 16, pattern)
    const template = makeTemplate(gray(16, 16, (x, y) => -pattern(x, y)).data, 16, 16)
    const score = referenceKernel.score(image, buildIntegral(image), template, 0, 0)
    assert.ok(Math.abs(score + 1) < 1e-5, `expected ~-1, got ${score}`)
  })

  it("is invariant to brightness and contrast", () => {
    // This is the whole point of normalising: the same mark on a dark scene and a
    // bright scene must score the same, or detection becomes a brightness detector.
    const base = gray(16, 16, pattern)
    const template = makeTemplate(gray(16, 16, pattern).data, 16, 16)

    const scaled = gray(16, 16, (x, y) => pattern(x, y) * 3 + 40)
    const a = referenceKernel.score(base, buildIntegral(base), template, 0, 0)
    const b = referenceKernel.score(scaled, buildIntegral(scaled), template, 0, 0)
    assert.ok(Math.abs(a - b) < 1e-4, `expected equal scores, got ${a} and ${b}`)
  })

  it("finds the template at its true offset within a larger image", () => {
    const image = gray(64, 64, (x, y) => (x * 5 + y * 3) % 23)
    // Stamp a distinctive block at a known position.
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) image.data[(20 + y) * 64 + (30 + x)] = x === y ? 255 : 0
    }
    const template = makeTemplate(
      gray(8, 8, (x, y) => (x === y ? 255 : 0)).data,
      8,
      8
    )
    const ii = buildIntegral(image)

    let best = { score: -Infinity, x: -1, y: -1 }
    for (let y = 0; y <= 64 - 8; y++) {
      for (let x = 0; x <= 64 - 8; x++) {
        const score = referenceKernel.score(image, ii, template, x, y)
        if (score > best.score) best = { score, x, y }
      }
    }
    assert.equal(best.x, 30)
    assert.equal(best.y, 20)
    assert.ok(best.score > 0.99)
  })

  it("returns 0 rather than NaN on a uniform patch", () => {
    // A flat region has zero variance; the correlation denominator would be 0.
    const image = gray(16, 16, () => 128)
    const template = makeTemplate(gray(8, 8, (x) => x).data, 8, 8)
    const score = referenceKernel.score(image, buildIntegral(image), template, 0, 0)
    assert.equal(score, 0)
    assert.ok(!Number.isNaN(score))
  })

  it("returns 0 for a flat template", () => {
    const image = gray(16, 16, (x, y) => x + y)
    const template = makeTemplate(new Float32Array(64).fill(5), 8, 8)
    assert.equal(referenceKernel.score(image, buildIntegral(image), template, 0, 0), 0)
  })

  it("returns 0 when the template would fall outside the image", () => {
    const image = gray(16, 16, (x, y) => x + y)
    const ii = buildIntegral(image)
    const template = makeTemplate(gray(8, 8, (x) => x).data, 8, 8)
    assert.equal(referenceKernel.score(image, ii, template, 12, 0), 0)
    assert.equal(referenceKernel.score(image, ii, template, 0, -1), 0)
  })
})

describe("sobelMagnitude", () => {
  it("responds at an edge and stays quiet on flat regions", () => {
    const image = gray(16, 16, (x) => (x < 8 ? 0 : 255))
    const edges = sobelMagnitude(image)
    const atEdge = edges.data[8 * 16 + 7] as number
    const inFlat = edges.data[8 * 16 + 3] as number
    assert.ok(atEdge > 100, `expected a strong edge response, got ${atEdge}`)
    assert.equal(inFlat, 0)
  })

  it("leaves the border zeroed rather than reading out of bounds", () => {
    const edges = sobelMagnitude(gray(8, 8, (x, y) => x * y))
    for (let x = 0; x < 8; x++) {
      assert.equal(edges.data[x], 0)
      assert.equal(edges.data[7 * 8 + x], 0)
    }
  })
})

describe("templateFromAlphaMap", () => {
  it("correlates a mark shape regardless of its alpha scale", () => {
    // NCC normalises intensity away, so a faint mark and a strong one of the same
    // shape must be equally detectable. Detection and intensity are separate problems.
    const shape = (x: number, y: number) => (Math.abs(x - 3.5) + Math.abs(y - 3.5) < 3 ? 1 : 0)
    const faint: AlphaMap = { width: 8, height: 8, data: gray(8, 8, (x, y) => shape(x, y) * 0.1).data }
    const strong: AlphaMap = { width: 8, height: 8, data: gray(8, 8, (x, y) => shape(x, y) * 0.9).data }

    const image = gray(8, 8, (x, y) => shape(x, y) * 200 + 20)
    const ii = buildIntegral(image)

    const a = referenceKernel.score(image, ii, templateFromAlphaMap(faint), 0, 0)
    const b = referenceKernel.score(image, ii, templateFromAlphaMap(strong), 0, 0)
    assert.ok(Math.abs(a - b) < 1e-5, `scale changed the score: ${a} vs ${b}`)
    assert.ok(a > 0.99)
  })
})
