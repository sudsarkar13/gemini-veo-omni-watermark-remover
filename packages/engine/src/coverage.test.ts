import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { coverage } from "./pipeline.ts"
import type { TrackedFrame, WatermarkTrack } from "./types.ts"

function track(id: string, from: number, to: number): WatermarkTrack {
  const frames = new Map<number, TrackedFrame>()
  for (let i = from; i <= to; i++) {
    frames.set(i, {
      rect: { x: 0, y: 0, width: 48, height: 48 },
      alpha: 1,
      confidence: 1,
      state: "detected",
    })
  }
  return { id, variant: "gemini-v1-48", frames, firstFrame: from, lastFrame: to }
}

describe("coverage", () => {
  it("reports nothing tracked for an empty plan", () => {
    const result = coverage([])
    assert.equal(result.firstFrame, -1)
    assert.equal(result.lastFrame, -1)
    assert.equal(result.framesUncovered, 0)
    assert.deepEqual(result.gaps, [])
  })

  it("finds no gaps in a continuous track", () => {
    const result = coverage([track("a", 0, 239)])
    assert.equal(result.framesUncovered, 0)
    assert.equal(result.firstFrame, 0)
    assert.equal(result.lastFrame, 239)
  })

  it("finds the run of frames between two tracks of the same mark", () => {
    // The real case: the mark was lost for sixteen frames, the track ended, and a new
    // one started afterwards. Those frames render untouched and still carry the mark.
    const result = coverage([track("a", 0, 69), track("b", 86, 239)])
    assert.deepEqual(result.gaps, [{ from: 70, to: 85 }])
    assert.equal(result.framesUncovered, 16)
  })

  it("does not count frames outside the tracked span as missed", () => {
    // Before the first detection and after the last there is no evidence the mark was
    // ever present. Counting those would invent a failure as readily as ignoring a
    // real gap hides one.
    const result = coverage([track("a", 100, 150)])
    assert.equal(result.framesUncovered, 0)
    assert.equal(result.firstFrame, 100)
    assert.equal(result.lastFrame, 150)
  })

  it("treats adjacent tracks as continuous", () => {
    assert.equal(coverage([track("a", 0, 10), track("b", 11, 20)]).framesUncovered, 0)
  })

  it("counts a single missing frame", () => {
    const result = coverage([track("a", 0, 5), track("b", 7, 10)])
    assert.deepEqual(result.gaps, [{ from: 6, to: 6 }])
    assert.equal(result.framesUncovered, 1)
  })

  it("handles overlapping tracks without inventing gaps", () => {
    // Two marks visible at once, each covering part of the clip.
    const result = coverage([track("a", 0, 120), track("b", 60, 239)])
    assert.equal(result.framesUncovered, 0)
    assert.equal(result.lastFrame, 239)
  })

  it("finds several gaps and totals them", () => {
    const result = coverage([track("a", 0, 9), track("b", 15, 19), track("c", 30, 39)])
    assert.deepEqual(result.gaps, [
      { from: 10, to: 14 },
      { from: 20, to: 29 },
    ])
    assert.equal(result.framesUncovered, 15)
  })
})
