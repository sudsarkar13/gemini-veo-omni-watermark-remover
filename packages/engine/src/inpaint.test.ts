import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { blend } from "./blend.ts"
import { scaleAlphaMap } from "./alpha-map.ts"
import { inpaint } from "./inpaint.ts"
import { createPlanner, renderFrame } from "./pipeline.ts"
import { syntheticDiamond } from "./templates.ts"
import type { Frame, Rect } from "./types.ts"

const WIDTH = 200
const HEIGHT = 160
const MARK: Rect = { x: 80, y: 60, width: 40, height: 40 }

/**
 * Diagonal stripes crossed by a brighter bar.
 *
 * Both a repeating texture and a single strong edge run through the region that gets
 * blanked out, which is what separates an exemplar fill from a blur: the stripes have
 * to stay stripes and the bar has to come out the other side.
 */
function scene(): Frame {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 3)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const stripe = (x + y) % 16 < 8 ? 90 : 140
      const bar = y > HEIGHT / 2 - 6 && y < HEIGHT / 2 + 6 ? 60 : 0
      const value = Math.min(255, stripe + bar)
      const o = (y * WIDTH + x) * 3
      data[o] = value
      data[o + 1] = value
      data[o + 2] = value
    }
  }
  return { width: WIDTH, height: HEIGHT, channels: 3, data }
}

function marked(): Frame {
  const frame = scene()
  blend(frame, scaleAlphaMap(syntheticDiamond(MARK.width), MARK.width, MARK.height), MARK, {
    gain: 1,
  })
  return frame
}

/** Mean absolute error against the clean scene, over a rectangle. */
function errorAgainstTruth(frame: Frame, rect: Rect): number {
  const truth = scene()
  let sum = 0
  let count = 0
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const o = (y * WIDTH + x) * 3
      sum += Math.abs((frame.data[o] as number) - (truth.data[o] as number))
      count++
    }
  }
  return sum / count
}

describe("inpaint", () => {
  it("replaces the mark with something much closer to what was underneath", () => {
    const frame = marked()
    const before = errorAgainstTruth(frame, MARK)

    const report = inpaint(frame, syntheticDiamond(MARK.width), MARK)

    assert.ok(report.filled > 0, "nothing was filled")
    assert.equal(report.incomplete, false)
    const after = errorAgainstTruth(frame, MARK)
    assert.ok(
      after < before * 0.5,
      `fill did not improve the region: ${before.toFixed(1)} -> ${after.toFixed(1)}`
    )
  })

  it("touches nothing outside the mark's own footprint", () => {
    const frame = marked()
    const before = frame.data.slice()

    inpaint(frame, syntheticDiamond(MARK.width), MARK)

    // The footprint plus the dilation the fill is allowed. Everything beyond it is
    // ordinary content that was never watermarked, and inventing over it would be
    // damage the user never asked for.
    const slack = 4
    let moved = 0
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const inside =
          x >= MARK.x - slack &&
          x < MARK.x + MARK.width + slack &&
          y >= MARK.y - slack &&
          y < MARK.y + MARK.height + slack
        if (inside) continue
        const o = (y * WIDTH + x) * 3
        if (before[o] !== frame.data[o]) moved++
      }
    }
    assert.equal(moved, 0, `${moved} pixels outside the region were changed`)
  })

  it("is deterministic", () => {
    // A stochastic fill would shimmer from frame to frame across a clip even where the
    // content is completely static, which is worse than the mark it replaced.
    const first = marked()
    const second = marked()
    inpaint(first, syntheticDiamond(MARK.width), MARK)
    inpaint(second, syntheticDiamond(MARK.width), MARK)
    assert.deepEqual(Array.from(first.data), Array.from(second.data))
  })

  it("leaves an alpha channel alone", () => {
    const rgb = marked()
    const rgba: Frame = {
      width: WIDTH,
      height: HEIGHT,
      channels: 4,
      data: new Uint8ClampedArray(WIDTH * HEIGHT * 4),
    }
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      rgba.data[i * 4] = rgb.data[i * 3] as number
      rgba.data[i * 4 + 1] = rgb.data[i * 3 + 1] as number
      rgba.data[i * 4 + 2] = rgb.data[i * 3 + 2] as number
      rgba.data[i * 4 + 3] = 128
    }

    inpaint(rgba, syntheticDiamond(MARK.width), MARK)

    for (let i = 3; i < rgba.data.length; i += 4) {
      assert.equal(rgba.data[i], 128, `transparency changed at byte ${i}`)
    }
  })

  it("fills a region flush against the frame edge without hanging", () => {
    // There is less to copy from and the answer will be worse, but the loop must still
    // terminate and say whether it managed.
    const frame = scene()
    const corner: Rect = { x: WIDTH - 40, y: HEIGHT - 40, width: 40, height: 40 }
    blend(frame, scaleAlphaMap(syntheticDiamond(40), 40, 40), corner, { gain: 1 })

    const report = inpaint(frame, syntheticDiamond(40), corner)
    assert.ok(report.filled > 0)
  })

  it("does nothing when the template covers nothing", () => {
    const frame = marked()
    const before = frame.data.slice()
    const empty = { width: 8, height: 8, data: new Float32Array(64) }

    const report = inpaint(frame, empty, MARK)

    assert.equal(report.filled, 0)
    assert.equal(report.patches, 0)
    assert.deepEqual(Array.from(frame.data), Array.from(before))
  })
})

/**
 * Where the fill is allowed to run.
 *
 * This is the part that keeps the fill compatible with the project's rule against
 * inventing pixels: not how it synthesises, but that it only ever does so on a region
 * somebody asserted and the maths refused.
 */
describe("the fill's licence", () => {
  const CLEAN_MARK: Rect = { x: 80, y: 60, width: 40, height: 40 }

  it("does not touch a mark that inverted cleanly, even when switched on", () => {
    const frame = marked()
    const planner = createPlanner(syntheticDiamond(CLEAN_MARK.width), {
      mode: "auto",
      sweepInterval: 1,
      sizes: [CLEAN_MARK.width],
      // This fixture's striped background scores 0.43 against the template, under the
      // discovery bar — correctly, for a single frame with nothing to corroborate it.
      // The subject here is the fill's licence, not the detector's sensitivity, so the
      // bar is lowered explicitly rather than the fixture being made unrealistically
      // easy.
      discoveryThreshold: 0.35,
    })
    planner.push(frame)
    const plan = planner.finish()
    assert.ok(plan.tracks.length >= 1, "fixture should be detected")

    const report = renderFrame(frame, plan, 0, syntheticDiamond(CLEAN_MARK.width), { fill: true })
    assert.ok(report.applied >= 1, "the exact path should have done the work")
    assert.equal(report.filled, 0, "the fill ran on a region that inverted cleanly")
  })

  it("records a drawn region the verifier refused, and leaves it alone unless asked", () => {
    // A box drawn over ordinary content: nothing there inverts, so nothing is removed.
    const frame = scene()
    const drawn: Rect = { x: 40, y: 40, width: 40, height: 40 }
    // A blot inside it, so "the fill wrote something" is observable. Without it the
    // scene's texture is perfectly periodic and a correct fill reproduces it byte for
    // byte — which is a fine property and a useless assertion.
    for (let y = drawn.y + 12; y < drawn.y + 28; y++) {
      for (let x = drawn.x + 12; x < drawn.x + 28; x++) {
        const o = (y * WIDTH + x) * 3
        frame.data[o] = 12
        frame.data[o + 1] = 12
        frame.data[o + 2] = 12
      }
    }
    const planner = createPlanner(syntheticDiamond(40), {
      mode: "auto",
      sweepInterval: 1,
      sizes: [40],
      manualMarks: [{ rect: drawn, fromFrame: 0, toFrame: 0 }],
    })
    planner.push(frame)
    const plan = planner.finish()

    assert.equal(plan.refusals.length, 1, "a refused hand-drawn region was not recorded")

    const untouched = frame.data.slice()
    const left = renderFrame(frame, plan, 0, syntheticDiamond(40))
    assert.equal(left.filled, 0)
    assert.deepEqual(Array.from(frame.data), Array.from(untouched), "pixels changed by default")

    const asked = renderFrame(frame, plan, 0, syntheticDiamond(40), { fill: true })
    assert.equal(asked.filled, 1, "the fill did not run where it was invited to")
    assert.notDeepEqual(Array.from(frame.data), Array.from(untouched))
  })

  it("has nowhere to run when nothing was found and nothing was drawn", () => {
    // The dangerous case: an unfound mark has no rectangle, so a fill would be
    // vandalism over a guess. There must be no rectangle to offer it.
    const frame = scene()
    const planner = createPlanner(syntheticDiamond(40), { mode: "auto", sweepInterval: 1 })
    planner.push(frame)
    const plan = planner.finish()

    const before = frame.data.slice()
    const report = renderFrame(frame, plan, 0, syntheticDiamond(40), { fill: true })

    assert.equal(report.filled, 0)
    assert.deepEqual(Array.from(frame.data), Array.from(before))
  })
})
