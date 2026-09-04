import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ALPHA_STEP_CAP } from "./constants.ts"
import { buildTracks, consolidate, ingestFrame, type MutableTrack, type Observation } from "./track.ts"
import type { Rect } from "./types.ts"

const box = (x: number, y: number, size = 24): Rect => ({ x, y, width: size, height: size })
const seen = (rect: Rect, alpha = 0.6, confidence = 0.8): Observation => ({ rect, alpha, confidence })

/** A mark parked in one place for `count` frames. */
function still(count: number, rect: Rect, alpha = 0.6): Observation[][] {
  return Array.from({ length: count }, () => [seen(rect, alpha)])
}

describe("ingestFrame", () => {
  it("links observations that stay near each other into one track", () => {
    const tracks: MutableTrack[] = []
    for (let f = 0; f < 5; f++) ingestFrame(tracks, f, [seen(box(100 + f * 2, 100))])
    assert.equal(tracks.length, 1)
    assert.equal(tracks[0]?.frames.size, 5)
  })

  it("starts a new track when a mark jumps beyond the match radius", () => {
    const tracks: MutableTrack[] = []
    ingestFrame(tracks, 0, [seen(box(100, 100))])
    ingestFrame(tracks, 1, [seen(box(400, 400))])
    assert.equal(tracks.length, 2)
  })

  it("follows two marks at once without confusing them", () => {
    // The corner mark plus a roaming one is the case that motivates the whole design.
    const tracks: MutableTrack[] = []
    for (let f = 0; f < 6; f++) {
      ingestFrame(tracks, f, [seen(box(500, 500)), seen(box(100 + f * 3, 80))])
    }
    assert.equal(tracks.length, 2)
    assert.ok(tracks.every((t) => t.frames.size === 6))
  })

  it("counts misses when a track goes unobserved", () => {
    const tracks: MutableTrack[] = []
    ingestFrame(tracks, 0, [seen(box(100, 100))])
    ingestFrame(tracks, 1, [])
    ingestFrame(tracks, 2, [])
    assert.equal(tracks[0]?.misses, 2)
  })

  it("stops matching a track once it has missed for too long", () => {
    const tracks: MutableTrack[] = []
    ingestFrame(tracks, 0, [seen(box(100, 100))])
    for (let f = 1; f <= 10; f++) ingestFrame(tracks, f, [], { missTolerance: 3 })
    ingestFrame(tracks, 11, [seen(box(100, 100))], { missTolerance: 3 })
    assert.equal(tracks.length, 2, "a long-dead track should not be resurrected")
  })
})

describe("consolidate", () => {
  it("drops tracks that never persisted", () => {
    // A lens flare or specular glint will not hold position for long. This is where
    // most false positives die.
    const result = buildTracks([[seen(box(10, 10))], [seen(box(11, 10))], []], { minPersistence: 8 })
    assert.equal(result.tracks.length, 0)
    assert.equal(result.rejected, 1)
  })

  it("keeps a track that persisted", () => {
    const result = buildTracks(still(12, box(200, 200)), { minPersistence: 8 })
    assert.equal(result.tracks.length, 1)
    assert.equal(result.rejected, 0)
  })

  it("bridges a short gap by interpolating from both sides", () => {
    const frames: Observation[][] = [
      ...still(6, box(100, 100)),
      [], [], [],
      ...still(6, box(130, 100)),
    ]
    const { tracks } = buildTracks(frames, { minPersistence: 8, matchRadius: 64 })
    assert.equal(tracks.length, 1)

    const track = tracks[0]!
    for (const f of [6, 7, 8]) {
      const frame = track.frames.get(f)
      assert.ok(frame, `frame ${f} should have been filled`)
      assert.equal(frame.state, "interpolated")
      // Position should move monotonically between the two anchors.
      assert.ok(frame.rect.x > 100 && frame.rect.x < 130, `x was ${frame.rect.x}`)
    }
  })

  it("marks a long gap occluded rather than inventing a position", () => {
    // Leaving the mark visible on a few frames is honest; smearing a correction
    // across pixels we cannot locate is not.
    const frames: Observation[][] = [
      ...still(10, box(100, 100)),
      ...Array.from({ length: 20 }, () => [] as Observation[]),
      ...still(10, box(100, 100)),
    ]
    const { tracks } = buildTracks(frames, {
      minPersistence: 8,
      missTolerance: 30,
      maxInterpolationGap: 15,
    })
    assert.equal(tracks.length, 1)
    assert.equal(tracks[0]?.frames.get(20)?.state, "occluded")
  })

  it("caps how fast alpha may change between frames", () => {
    // One bad measurement must not become a visible flash in the output.
    const frames: Observation[][] = [
      ...still(6, box(100, 100), 0.6),
      [seen(box(100, 100), 1.4)], // wild outlier
      ...still(6, box(100, 100), 0.6),
    ]
    const { tracks } = buildTracks(frames, { minPersistence: 8 })
    const track = tracks[0]!

    const ordered = [...track.frames.keys()].sort((a, b) => a - b)
    for (let i = 1; i < ordered.length; i++) {
      const previous = track.frames.get(ordered[i - 1] as number)!.alpha
      const current = track.frames.get(ordered[i] as number)!.alpha
      assert.ok(
        Math.abs(current - previous) <= ALPHA_STEP_CAP + 1e-9,
        `alpha jumped ${Math.abs(current - previous)} between frames ${ordered[i - 1]} and ${ordered[i]}`
      )
    }
  })

  it("absorbs an outlier instead of tracking it", () => {
    const frames: Observation[][] = [
      ...still(10, box(100, 100), 0.6),
      [seen(box(100, 100), 1.5)],
      ...still(10, box(100, 100), 0.6),
    ]
    const { tracks } = buildTracks(frames, { minPersistence: 8 })
    const spike = tracks[0]!.frames.get(10)!.alpha
    assert.ok(spike < 0.7, `outlier leaked through as ${spike}`)
  })

  it("reports the true first and last observed frames", () => {
    const frames: Observation[][] = [[], [], ...still(10, box(50, 50)), [], []]
    const { tracks } = buildTracks(frames, { minPersistence: 8 })
    assert.equal(tracks[0]?.firstFrame, 2)
    assert.equal(tracks[0]?.lastFrame, 11)
  })

  it("does not let occluded frames drag the alpha smoothing", () => {
    const frames: Observation[][] = [
      ...still(10, box(100, 100), 0.6),
      ...Array.from({ length: 20 }, () => [] as Observation[]),
      ...still(10, box(100, 100), 0.6),
    ]
    const { tracks } = buildTracks(frames, {
      minPersistence: 8,
      missTolerance: 30,
      maxInterpolationGap: 15,
    })
    const after = tracks[0]!.frames.get(30)!
    assert.equal(after.state, "detected")
    assert.ok(Math.abs(after.alpha - 0.6) < 1e-6, `alpha drifted to ${after.alpha}`)
  })

  it("removes single-pixel position jitter from a stationary mark", () => {
    // Position is estimated per frame, so a still mark wobbles as noise moves the
    // correlation peak. Measured against ground truth, one pixel of offset costs
    // roughly six times what a 0.03 alpha error does, because the mark's alpha falls
    // off steeply at its rim and a misaligned correction leaves visible crescents.
    const jitter = [0, 1, 0, -1, 0, 1, 0, 0, -1, 0, 1, 0]
    const frames = jitter.map((d) => [seen(box(100 + d, 100 + d))])

    const { tracks } = buildTracks(frames, { minPersistence: 8, positionWindow: 5 })
    const track = tracks[0]!

    const xs = [...track.frames.values()].map((f) => f.rect.x)
    assert.ok(
      xs.every((x) => x === 100),
      `jitter survived smoothing: ${[...new Set(xs)].join(",")}`
    )
  })

  it("still follows genuine motion through the median filter", () => {
    // A median must not smear real movement, only reject isolated excursions.
    const frames = Array.from({ length: 14 }, (_, i) => [seen(box(40 + i * 5, 60))])
    const { tracks } = buildTracks(frames, { minPersistence: 8, matchRadius: 32 })
    const track = tracks[0]!
    const first = track.frames.get(track.firstFrame)!.rect.x
    const last = track.frames.get(track.lastFrame)!.rect.x
    assert.ok(last - first >= 55, `motion was flattened: ${first} -> ${last}`)
  })

  it("handles an empty timeline", () => {
    const result = consolidate([], {})
    assert.deepEqual(result.tracks, [])
    assert.equal(result.rejected, 0)
  })
})
