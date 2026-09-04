import assert from "node:assert/strict"
import { totalmem } from "node:os"
import { describe, it } from "node:test"

import { estimate, formatBytes, formatDuration } from "./estimate.ts"
import type { ClipInfo } from "@gvowr/ipc"

function clip(patch: Partial<ClipInfo> = {}): ClipInfo {
  return {
    width: 1920,
    height: 1080,
    frameRate: 30,
    durationSeconds: 10,
    frameCount: 300,
    videoCodec: "h264",
    hasAudio: true,
    audioCodec: "aac",
    bitRate: 8_000_000,
    sizeBytes: 10 * 1024 * 1024,
    calibratedResolution: false,
    ...patch,
  }
}

describe("estimate", () => {
  it("scales with pixels and frame count", () => {
    const short = estimate(clip({ frameCount: 100 }))
    const long = estimate(clip({ frameCount: 1000 }))
    assert.ok(long.seconds > short.seconds * 5, "ten times the frames should cost far more")

    const sd = estimate(clip({ width: 640, height: 360 }))
    const hd = estimate(clip())
    assert.ok(hd.seconds > sd.seconds, "more pixels should cost more")
  })

  it("keeps peak memory to a working set, not the whole clip", () => {
    // Frames are streamed, so a long clip must not predict a proportionally huge
    // footprint — that is the entire reason the planner is incremental.
    const short = estimate(clip({ frameCount: 100 }))
    const long = estimate(clip({ frameCount: 100_000 }))
    assert.equal(short.peakMemoryBytes, long.peakMemoryBytes)
  })

  it("flags a large file as heavy", () => {
    assert.equal(estimate(clip()).heavy, false)
    assert.equal(estimate(clip({ sizeBytes: 900 * 1024 * 1024 })).heavy, true)
  })

  it("flags a long clip as heavy", () => {
    assert.equal(estimate(clip({ durationSeconds: 600, frameCount: 18_000 })).heavy, true)
  })

  it("flags 4K as heavy", () => {
    assert.equal(estimate(clip({ width: 3840, height: 2160 })).heavy, true)
  })

  it("reports when an estimate exceeds physical memory", () => {
    const absurd = estimate(clip({ width: 30_000, height: 30_000 }))
    assert.ok(absurd.peakMemoryBytes > totalmem() || absurd.exceedsResources)
    assert.equal(absurd.exceedsResources, true)
  })

  it("scales peak memory with concurrency", () => {
    assert.ok(estimate(clip(), 4).peakMemoryBytes > estimate(clip(), 1).peakMemoryBytes)
  })
})

describe("formatting", () => {
  it("formats bytes at sensible precision", () => {
    assert.equal(formatBytes(512), "512 B")
    assert.equal(formatBytes(1536), "1.5 KB")
    assert.equal(formatBytes(50 * 1024 * 1024), "50 MB")
  })

  it("formats durations", () => {
    assert.equal(formatDuration(45), "45s")
    assert.equal(formatDuration(130), "2m 10s")
    assert.equal(formatDuration(7200), "2h 0m")
  })

  it("does not present nonsense as a number", () => {
    assert.equal(formatDuration(Number.NaN), "unknown")
    assert.equal(formatDuration(-5), "unknown")
  })
})
