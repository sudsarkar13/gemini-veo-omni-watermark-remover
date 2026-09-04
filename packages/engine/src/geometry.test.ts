import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  CALIBRATED_PROFILES,
  VEO_720P_COMPACT,
  VEO_720P_STANDARD,
  clampRect,
  cornerCandidates,
  genericCornerRect,
  hasCalibratedProfile,
  profileRect,
  profilesFor,
} from "./geometry.ts"

describe("calibrated profiles", () => {
  it("places the 720p standard mark at its measured position", () => {
    assert.deepEqual(profileRect(VEO_720P_STANDARD, 1280, 720), {
      x: 1160,
      y: 600,
      width: 48,
      height: 48,
    })
  })

  it("places the 720p compact mark at its measured position", () => {
    assert.deepEqual(profileRect(VEO_720P_COMPACT, 1280, 720), {
      x: 1207,
      y: 636,
      width: 44,
      height: 44,
    })
  })

  it("reports calibration only for the exact measured frame size", () => {
    assert.equal(hasCalibratedProfile(1280, 720), true)
    // Known gaps. These must stay false until real samples are measured, so the
    // engine never presents a guess as a measurement. See docs/PLAN.md §9.
    assert.equal(hasCalibratedProfile(3840, 2160), false, "4K")
    assert.equal(hasCalibratedProfile(1080, 1080), false, "1:1")
    assert.equal(hasCalibratedProfile(1080, 1920), false, "9:16")
    assert.equal(hasCalibratedProfile(720, 1280), false, "720p portrait is not 720p landscape")
  })

  it("does not offer profiles measured at other resolutions", () => {
    assert.equal(profilesFor(1280, 720).length, 3)
    assert.equal(profilesFor(1920, 1080).length, 0)
  })
})

describe("genericCornerRect", () => {
  it("agrees with the measured 720p standard profile", () => {
    // The generic formula is derived from that measurement, so at 1280x720 the two
    // must coincide. If this ever diverges, one of them is wrong.
    assert.deepEqual(genericCornerRect(1280, 720), profileRect(VEO_720P_STANDARD, 1280, 720))
  })

  it("scales from the short edge, so orientation does not change the size", () => {
    const landscape = genericCornerRect(1920, 1080)
    const portrait = genericCornerRect(1080, 1920)
    assert.equal(landscape.width, portrait.width)
    assert.equal(landscape.width, 72) // round(1080 / 15)
  })

  it("keeps the mark inside the frame", () => {
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
      [1080, 1920],
      [3840, 2160],
      [1080, 1080],
      [256, 256],
    ] as const) {
      const r = genericCornerRect(w, h)
      assert.ok(r.x >= 0 && r.y >= 0, `${w}x${h} produced a negative origin`)
      assert.ok(r.x + r.width <= w, `${w}x${h} overflowed horizontally`)
      assert.ok(r.y + r.height <= h, `${w}x${h} overflowed vertically`)
    }
  })

  it("enforces a minimum size on tiny frames", () => {
    assert.equal(genericCornerRect(120, 120).width, 24)
  })

  it("rejects invalid dimensions", () => {
    assert.throws(() => genericCornerRect(0, 100), RangeError)
    assert.throws(() => genericCornerRect(100, -1), RangeError)
    assert.throws(() => genericCornerRect(100.5, 100), RangeError)
  })
})

describe("cornerCandidates", () => {
  it("returns the measured profiles without a redundant generic guess at 720p", () => {
    const candidates = cornerCandidates(1280, 720)
    // The generic rect equals the standard profile here, so it must be deduplicated.
    assert.equal(candidates.length, CALIBRATED_PROFILES.length)
    assert.ok(candidates.every((c) => c.calibrated))
    // The placement we measured ourselves is offered first.
    assert.equal(candidates[0]?.profile?.id, "veo-720p-inset")
  })

  it("falls back to a single uncalibrated guess at unmeasured resolutions", () => {
    const candidates = cornerCandidates(1080, 1920)
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]?.calibrated, false)
    assert.equal(candidates[0]?.profile, null)
  })
})

describe("clampRect", () => {
  it("pulls an overflowing rect back inside without shrinking it", () => {
    const r = clampRect({ x: 100, y: 100, width: 20, height: 20 }, 64, 64)
    assert.deepEqual(r, { x: 44, y: 44, width: 20, height: 20 })
  })

  it("shrinks a rect larger than the frame", () => {
    const r = clampRect({ x: 0, y: 0, width: 100, height: 100 }, 32, 48)
    assert.deepEqual(r, { x: 0, y: 0, width: 32, height: 48 })
  })

  it("pushes a negative origin back to zero", () => {
    assert.deepEqual(clampRect({ x: -5, y: -5, width: 10, height: 10 }, 64, 64), {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    })
  })
})
