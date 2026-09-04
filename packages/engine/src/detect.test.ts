import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { LOGO_VALUE } from "./constants.ts"
import type { Grayscale } from "./correlate.ts"
import {
  analyseFrame,
  defaultSizes,
  downsample2,
  overlap,
  scoreAt,
  searchWindow,
  sizeTemplate,
  suppressOverlaps,
  sweepFrame,
  varianceScore,
  type Candidate,
} from "./detect.ts"
import { buildIntegral } from "./correlate.ts"
import type { AlphaMap, Rect } from "./types.ts"

/**
 * Deterministic pseudo-random texture over a gentle gradient.
 *
 * Deliberately not a sine grid: a strongly periodic scene creates real correlation
 * aliasing, where background positions are genuinely as good a match as the mark, and
 * no detector can be expected to resolve that. This is closer to real footage.
 */
function scene(width: number, height: number): Grayscale {
  const data = new Float32Array(width * height)
  let seed = 0x2f6e2b1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const noise = (seed >>> 24) / 255
      data[y * width + x] = 60 + 60 * (x / width) + 40 * noise
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

function stamp(image: Grayscale, alpha: AlphaMap, at: { x: number; y: number }, gain = 1): void {
  for (let row = 0; row < alpha.height; row++) {
    for (let col = 0; col < alpha.width; col++) {
      const a = Math.min((alpha.data[row * alpha.width + col] as number) * gain, 0.99)
      const i = (at.y + row) * image.width + at.x + col
      image.data[i] = a * LOGO_VALUE + (1 - a) * (image.data[i] as number)
    }
  }
}

describe("varianceScore", () => {
  it("is high where a region is flatter than its surroundings", () => {
    const image = scene(64, 64)
    for (let y = 20; y < 36; y++) {
      for (let x = 20; x < 36; x++) image.data[y * 64 + x] = 200
    }
    const score = varianceScore(buildIntegral(image), { x: 20, y: 20, width: 16, height: 16 })
    assert.ok(score > 0.8, `expected strong dampening, got ${score}`)
  })

  it("is near zero where texture matches the surroundings", () => {
    const image = scene(64, 64)
    const score = varianceScore(buildIntegral(image), { x: 20, y: 20, width: 16, height: 16 })
    assert.ok(score < 0.4, `expected little dampening, got ${score}`)
  })
})

describe("downsample2", () => {
  it("halves both dimensions", () => {
    const small = downsample2(scene(64, 32))
    assert.equal(small.width, 32)
    assert.equal(small.height, 16)
  })

  it("averages rather than dropping samples", () => {
    const image: Grayscale = { width: 2, height: 2, data: new Float32Array([0, 100, 200, 100]) }
    assert.equal(downsample2(image).data[0], 100)
  })
})

describe("overlap and suppression", () => {
  const at = (x: number, y: number, score: number): Candidate => ({
    rect: { x, y, width: 10, height: 10 },
    score,
    spatial: score,
    gradient: score,
    variance: score,
  })

  it("computes intersection over union", () => {
    assert.equal(overlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 }), 1)
    assert.equal(overlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 50, y: 50, width: 10, height: 10 }), 0)
  })

  it("keeps the strongest of a cluster and drops the rest", () => {
    const kept = suppressOverlaps([at(0, 0, 0.5), at(1, 1, 0.9), at(2, 2, 0.6)], 0.3)
    assert.equal(kept.length, 1)
    assert.equal(kept[0]?.score, 0.9)
  })

  it("keeps detections that do not overlap", () => {
    assert.equal(suppressOverlaps([at(0, 0, 0.5), at(40, 40, 0.4)], 0.3).length, 2)
  })
})

describe("scoreAt", () => {
  it("scores a stamped mark far above surrounding background", () => {
    const template = diamond(24, 0.85)
    const image = scene(128, 128)
    const at = { x: 60, y: 60 }
    stamp(image, template, at)

    const analysis = analyseFrame(image)
    const sized = sizeTemplate(template, 24)

    const onMark = scoreAt(analysis, sized, at.x, at.y)
    const offMark = scoreAt(analysis, sized, 10, 10)
    assert.ok(
      onMark.score > offMark.score + 0.25,
      `on-mark ${onMark.score} vs off-mark ${offMark.score}`
    )
    assert.ok(onMark.score >= 0.35, `on-mark score ${onMark.score} below threshold`)
  })

  it("detects the mark against a bright background too (polarity invariance)", () => {
    // On a bright scene the correlation flips sign; taking the magnitude keeps it.
    const template = diamond(24, 0.85)
    const image = scene(128, 128)
    for (let i = 0; i < image.data.length; i++) image.data[i] = 255 - (image.data[i] as number)
    const at = { x: 60, y: 60 }
    stamp(image, template, at)

    const result = scoreAt(analyseFrame(image), sizeTemplate(template, 24), at.x, at.y)
    assert.ok(result.spatial > 0.4, `spatial score ${result.spatial} too low on a bright scene`)
  })
})

describe("searchWindow", () => {
  it("locates a mark placed anywhere, not only in the corner", () => {
    // The whole point of the project: prior art computes a corner rect and looks only
    // there, so a mark in the middle of the frame is invisible to it.
    const template = diamond(20, 0.85)
    for (const at of [
      { x: 12, y: 14 },
      { x: 70, y: 30 },
      { x: 44, y: 66 },
    ]) {
      const image = scene(128, 128)
      stamp(image, template, at)
      const best = searchWindow(
        analyseFrame(image),
        [sizeTemplate(template, 20)],
        { x: at.x - 5, y: at.y - 5, width: 10, height: 10 }
      )
      assert.ok(best, "expected a candidate")
      assert.ok(
        Math.abs(best.rect.x - at.x) <= 1 && Math.abs(best.rect.y - at.y) <= 1,
        `expected ~(${at.x},${at.y}), got (${best.rect.x},${best.rect.y})`
      )
    }
  })

  it("returns null when the window admits no valid position", () => {
    const image = scene(64, 64)
    const best = searchWindow(analyseFrame(image), [sizeTemplate(diamond(20, 0.8), 20)], {
      x: 60,
      y: 60,
      width: 2,
      height: 2,
    })
    assert.equal(best, null)
  })
})

describe("sweepFrame", () => {
  it("finds a mark mid-frame without any positional prior", () => {
    const template = diamond(24, 0.85)
    const image = scene(256, 256)
    const at = { x: 96, y: 72 }
    stamp(image, template, at)

    const candidates = sweepFrame(analyseFrame(image), template, { sizes: [24] })

    assert.ok(candidates.length > 0, "sweep found nothing")
    const found = candidates.some(
      (c: Candidate) => Math.abs(c.rect.x - at.x) <= 8 && Math.abs(c.rect.y - at.y) <= 8
    )
    assert.ok(
      found,
      `mark at (${at.x},${at.y}) missed; got ${candidates.map((c) => `(${c.rect.x},${c.rect.y})@${c.score.toFixed(2)}`).join(" ")}`
    )
  })

  it("finds a mark in the bottom-right corner as well", () => {
    const template = diamond(24, 0.85)
    const image = scene(256, 256)
    const at = { x: 256 - 24 - 25, y: 256 - 24 - 25 }
    stamp(image, template, at)

    const candidates = sweepFrame(analyseFrame(image), template, { sizes: [24] })
    assert.ok(
      candidates.some((c) => Math.abs(c.rect.x - at.x) <= 8 && Math.abs(c.rect.y - at.y) <= 8),
      "corner mark missed"
    )
  })

  it("never returns more candidates than asked for", () => {
    const image = scene(256, 256)
    const candidates = sweepFrame(analyseFrame(image), diamond(24, 0.85), {
      sizes: [24],
      maxCandidates: 3,
      threshold: 0,
    })
    assert.ok(candidates.length <= 3)
  })

  it("returns non-overlapping candidates", () => {
    const image = scene(256, 256)
    const candidates = sweepFrame(analyseFrame(image), diamond(24, 0.85), {
      sizes: [24],
      threshold: 0,
    })
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i] as Candidate
        const b = candidates[j] as Candidate
        assert.ok(overlap(a.rect, b.rect) <= 0.3, "candidates overlap after suppression")
      }
    }
  })
})

describe("defaultSizes", () => {
  it("brackets the generic corner prior", () => {
    const sizes = defaultSizes(1920, 1080)
    const prior = Math.round(1080 / 15) // 72
    assert.ok((sizes[0] as number) < prior)
    assert.ok((sizes.at(-1) as number) > prior)
  })

  it("is sorted, deduplicated, and never degenerate", () => {
    const sizes = defaultSizes(320, 180)
    assert.deepEqual(sizes, [...new Set(sizes)].sort((a, b) => a - b))
    assert.ok(sizes.every((s) => s >= 16))
  })
})
