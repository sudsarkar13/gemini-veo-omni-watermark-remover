import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { blend } from "./blend.ts"
import { scaleAlphaMap } from "./alpha-map.ts"
import { planClip, renderFrame } from "./pipeline.ts"
import type { AlphaMap, Frame, Rect } from "./types.ts"

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

function frame(width: number, height: number, seedOffset: number): Frame {
  const data = new Uint8ClampedArray(width * height * 3)
  let seed = (0x9e3779b1 ^ seedOffset) >>> 0
  for (let i = 0; i < width * height; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    // Noise amplitude matters here. Uncorrelated noise is what suppresses correlation
    // scores, and at +/-32 levels — roughly six times a real H.264 encode — a genuine
    // mark scores 0.50 instead of the 0.78 it scores on real footage. A fixture that
    // noisy makes any detection threshold tuned against it meaningless.
    const noise = (seed >>> 25) & 0x0f
    const base = 70 + Math.round(60 * ((i % width) / width)) + noise
    data[i * 3] = base
    data[i * 3 + 1] = base
    data[i * 3 + 2] = base
  }
  return { width, height, channels: 3, data }
}

function stamped(width: number, height: number, seed: number, mark: AlphaMap, at: Rect, gain: number): Frame {
  const f = frame(width, height, seed)
  blend(f, scaleAlphaMap(mark, at.width, at.height), at, { gain })
  return f
}

const MARK = diamond(24, 0.85)
const SIZE = { width: 192, height: 192 }

describe("planClip", () => {
  it("tracks a stationary mark across a clip", () => {
    const at: Rect = { x: 120, y: 130, width: 24, height: 24 }
    const frames = Array.from({ length: 20 }, (_, i) =>
      stamped(SIZE.width, SIZE.height, i, MARK, at, 0.8)
    )

    const plan = planClip(frames, MARK, { sizes: [24], minPersistence: 8, sweepInterval: 5 })

    assert.equal(plan.tracks.length, 1, "expected exactly one track")
    const track = plan.tracks[0]!
    assert.ok(track.frames.size >= 15, `only covered ${track.frames.size} frames`)

    const first = track.frames.get(track.firstFrame)!
    assert.ok(Math.abs(first.rect.x - at.x) <= 3, `x off by ${first.rect.x - at.x}`)
    assert.ok(Math.abs(first.rect.y - at.y) <= 3, `y off by ${first.rect.y - at.y}`)
  })

  it("follows a mark that moves through the frame", () => {
    // The roaming case. A corner-only tool cannot represent this at all.
    const frames = Array.from({ length: 20 }, (_, i) =>
      stamped(SIZE.width, SIZE.height, i, MARK, { x: 30 + i * 4, y: 60, width: 24, height: 24 }, 0.8)
    )

    const plan = planClip(frames, MARK, { sizes: [24], minPersistence: 8, sweepInterval: 5 })
    assert.ok(plan.tracks.length >= 1, "lost a moving mark entirely")

    const track = plan.tracks[0]!
    const start = track.frames.get(track.firstFrame)!
    const end = track.frames.get(track.lastFrame)!
    assert.ok(end.rect.x > start.rect.x + 20, `track did not follow the motion: ${start.rect.x} -> ${end.rect.x}`)
  })

  it("finds nothing in clean footage", () => {
    const frames = Array.from({ length: 20 }, (_, i) => frame(SIZE.width, SIZE.height, i))
    const plan = planClip(frames, MARK, { sizes: [24], minPersistence: 8, sweepInterval: 5 })
    assert.equal(plan.tracks.length, 0, "hallucinated a watermark in clean footage")
  })

  it("reports honest diagnostics", () => {
    const at: Rect = { x: 120, y: 130, width: 24, height: 24 }
    const frames = Array.from({ length: 12 }, (_, i) =>
      stamped(SIZE.width, SIZE.height, i, MARK, at, 0.8)
    )
    const plan = planClip(frames, MARK, { sizes: [24], minPersistence: 8, sweepInterval: 5 })

    assert.equal(plan.diagnostics.frameCount, 12)
    assert.equal(plan.diagnostics.width, SIZE.width)
    // 192x192 is not a resolution anyone has calibrated, and we must say so.
    assert.equal(plan.diagnostics.calibratedResolution, false)
    assert.ok(plan.diagnostics.sweeps > 0)
    assert.equal(plan.diagnostics.frames.length, 12)
  })

  it("handles an empty clip without throwing", () => {
    const plan = planClip([], MARK, {})
    assert.equal(plan.tracks.length, 0)
    assert.equal(plan.diagnostics.frameCount, 0)
  })
})

describe("renderFrame", () => {
  it("removes the mark it planned for", () => {
    const at: Rect = { x: 120, y: 130, width: 24, height: 24 }
    const frames = Array.from({ length: 16 }, (_, i) =>
      stamped(SIZE.width, SIZE.height, i, MARK, at, 0.8)
    )
    const plan = planClip(frames, MARK, { sizes: [24], minPersistence: 8, sweepInterval: 5 })
    assert.ok(plan.tracks.length > 0, "nothing planned, cannot test rendering")

    const index = plan.tracks[0]!.firstFrame
    const dirty = stamped(SIZE.width, SIZE.height, index, MARK, at, 0.8)
    const clean = frame(SIZE.width, SIZE.height, index)

    const errorBefore = meanError(dirty, clean, at)
    renderFrame(dirty, plan, index, MARK)
    const errorAfter = meanError(dirty, clean, at)

    assert.ok(
      errorAfter < errorBefore * 0.35,
      `removal barely helped: ${errorBefore.toFixed(1)} -> ${errorAfter.toFixed(1)}`
    )
  })

  it("leaves frames with no plan entry untouched", () => {
    const plan = planClip([], MARK, {})
    const f = frame(64, 64, 1)
    const before = Uint8ClampedArray.from(f.data)
    const report = renderFrame(f, plan, 0, MARK)
    assert.deepEqual(f.data, before)
    assert.equal(report.applied, 0)
  })
})

/** Mean absolute luminance error over a region. */
function meanError(a: Frame, b: Frame, rect: Rect): number {
  let total = 0
  let count = 0
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const i = (y * a.width + x) * 3
      total += Math.abs((a.data[i] as number) - (b.data[i] as number))
      count++
    }
  }
  return count > 0 ? total / count : 0
}
