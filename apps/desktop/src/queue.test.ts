import assert from "node:assert/strict"
import { join } from "node:path"
import { describe, it } from "node:test"

import { isFinished, outputPathFor } from "./queue.ts"
import type { JobState } from "@gvowr/ipc"

describe("outputPathFor", () => {
  it("writes beside the source by default", () => {
    assert.equal(outputPathFor("/videos/clip.mp4", null), join("/videos", "clip_clean.mp4"))
  })

  it("honours an explicit output directory", () => {
    assert.equal(outputPathFor("/videos/clip.mov", "/out"), join("/out", "clip_clean.mov"))
  })

  it("preserves the container extension", () => {
    assert.ok(outputPathFor("/v/a.mkv", null).endsWith("a_clean.mkv"))
    assert.ok(outputPathFor("/v/a.webm", null).endsWith("a_clean.webm"))
  })

  it("never overwrites the source", () => {
    const input = "/videos/clip.mp4"
    assert.notEqual(outputPathFor(input, null), input)
  })

  it("falls back to .mp4 for an extensionless input", () => {
    assert.ok(outputPathFor("/videos/clip", null).endsWith("clip_clean.mp4"))
  })

  it("keeps dots inside the filename", () => {
    assert.ok(outputPathFor("/v/my.holiday.clip.mp4", null).endsWith("my.holiday.clip_clean.mp4"))
  })
})

describe("isFinished", () => {
  it("treats every terminal state as finished", () => {
    for (const state of [
      "done",
      "done-with-skips",
      "no-mark-found",
      "failed",
      "cancelled",
    ] as JobState[]) {
      assert.equal(isFinished(state), true, `${state} should be terminal`)
    }
  })

  it("treats in-flight states as unfinished", () => {
    for (const state of ["queued", "analysing", "ready", "processing"] as JobState[]) {
      assert.equal(isFinished(state), false, `${state} should not be terminal`)
    }
  })
})
