import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { scaleAlphaMap } from "./alpha-map.ts"
import { blend } from "./blend.ts"
import { planClip, renderFrame } from "./pipeline.ts"
import { checkResidual } from "./residual.ts"
import type { AlphaMap, Frame, Rect } from "./types.ts"

/**
 * Fixtures mirror `pipeline.test.ts` deliberately.
 *
 * The residual check has to agree with the pipeline about what a removed mark looks
 * like, so testing it against a different synthetic world would prove nothing about
 * whether it will agree with the renderer on a real one.
 */

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
    const noise = (seed >>> 25) & 0x0f
    const base = 70 + Math.round(60 * ((i % width) / width)) + noise
    data[i * 3] = base
    data[i * 3 + 1] = base
    data[i * 3 + 2] = base
  }
  return { width, height, channels: 3, data }
}

function stamped(seed: number, at: Rect, gain: number): Frame {
  const f = frame(SIZE, SIZE, seed)
  blend(f, scaleAlphaMap(MARK, at.width, at.height), at, { gain })
  return f
}

const MARK = diamond(24, 0.85)
const SIZE = 192
const AT: Rect = { x: 120, y: 130, width: 24, height: 24 }
const OPTIONS = { sizes: [24], sweepInterval: 5 } as const

describe("checkResidual", () => {
  it("finds a mark the plan never touched", () => {
    const frames = Array.from({ length: 20 }, (_, i) => stamped(i, AT, 0.8))

    const report = checkResidual(frames, MARK, OPTIONS)

    assert.equal(report.framesChecked, 20)
    assert.ok(report.ranges.length >= 1, "expected the untouched mark to be reported")
    const first = report.ranges[0]!
    assert.equal(first.kind, "missed")
    // Found by a sweep, then followed to the end of the clip.
    assert.ok(first.from <= OPTIONS.sweepInterval, `found late, at frame ${first.from}`)
    assert.equal(first.to, 19)
    assert.ok(report.framesMarked >= 15, `only ${report.framesMarked} frames flagged`)
  })

  it("reports nothing on frames that never carried a mark", () => {
    const frames = Array.from({ length: 20 }, (_, i) => frame(SIZE, SIZE, i))

    const report = checkResidual(frames, MARK, OPTIONS)

    assert.deepEqual(report.ranges, [])
    assert.equal(report.framesMarked, 0)
    assert.equal(report.framesChecked, 20)
  })

  it("reports nothing once the mark has actually been removed", () => {
    const frames = Array.from({ length: 20 }, (_, i) => stamped(i, AT, 0.8))
    const plan = planClip(frames, MARK, { sizes: [24], minPersistence: 8, sweepInterval: 5 })
    assert.equal(plan.tracks.length, 1, "fixture precondition: the mark is found")

    const rendered = frames.map((f, i) => {
      const copy: Frame = { ...f, data: new Uint8ClampedArray(f.data) }
      renderFrame(copy, plan, i, MARK)
      return copy
    })

    const report = checkResidual(rendered, MARK, { ...OPTIONS, tracks: plan.tracks })

    assert.equal(report.framesMarked, 0, `still marked on ${report.framesMarked} frames`)
    assert.deepEqual(report.ranges, [])
  })

  it("catches a correction that under-shot, without any searching", () => {
    // The plan says it corrected this rectangle on every frame. It did not: the mark
    // is still there at most of its strength. Only the per-track re-score can see
    // this — the sweep would find it too, but not until frame 0 or 5.
    const frames = Array.from({ length: 4 }, (_, i) => stamped(i, AT, 0.8))
    const plan = planClip(frames, MARK, { sizes: [24], minPersistence: 2, sweepInterval: 2 })
    assert.equal(plan.tracks.length, 1, "fixture precondition: the mark is found")

    // A sweep interval past the end of the clip, so the only signal available is the
    // track rectangle the plan claims to have fixed.
    const report = checkResidual(frames.slice(1), MARK, {
      sizes: [24],
      sweepInterval: 1000,
      tracks: plan.tracks,
    })

    assert.equal(report.sweeps, 1, "expected a single sweep at frame 0")
    assert.ok(report.ranges.length >= 1, "expected the under-shoot to be reported")
    assert.ok(
      report.ranges.some((range) => range.kind === "under-corrected"),
      `kinds were ${report.ranges.map((r) => r.kind).join(", ")}`
    )
  })

  it("carries the sweep interval, because a range's start is a confirmation not a claim", () => {
    // The mark appears at frame 7, but sweeps land on 0, 6, 12. It cannot be confirmed
    // before frame 12 and the report must not pretend otherwise.
    const frames = Array.from({ length: 20 }, (_, i) =>
      i >= 7 ? stamped(i, AT, 0.8) : frame(SIZE, SIZE, i)
    )

    const report = checkResidual(frames, MARK, { sizes: [24], sweepInterval: 6 })

    assert.equal(report.sweepInterval, 6)
    assert.ok(report.ranges.length >= 1, "expected the late mark to be found")
    const range = report.ranges[0]!
    assert.ok(range.from >= 7, `claimed the mark before it existed, at frame ${range.from}`)
    assert.ok(range.from <= 12, `took until frame ${range.from} to notice`)
  })
})
