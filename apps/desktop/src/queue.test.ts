import assert from "node:assert/strict"
import { join } from "node:path"
import { describe, it } from "node:test"

import { isFinished, outputPathFor } from "./queue.ts"
import { kindOf } from "@gvowr/ipc"
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

describe("outputPathFor, with stills", () => {
  it("keeps the image format in the name", () => {
    // The result is written back in the format it came in, so the extension is not a
    // cosmetic choice — a .png named .jpg would be a file nothing can open correctly.
    assert.ok(outputPathFor("/photos/shot.png", null).endsWith("shot_clean.png"))
    assert.ok(outputPathFor("/photos/shot.jpeg", null).endsWith("shot_clean.jpeg"))
    assert.ok(outputPathFor("/photos/shot.webp", "/out").endsWith("shot_clean.webp"))
  })
})

describe("kindOf", () => {
  it("routes by extension, case-insensitively", () => {
    assert.equal(kindOf("/photos/a.PNG"), "image")
    assert.equal(kindOf("/photos/a.jpg"), "image")
    assert.equal(kindOf("/photos/a.jpeg"), "image")
    assert.equal(kindOf("/photos/a.webp"), "image")
    assert.equal(kindOf("/videos/a.mp4"), "video")
    assert.equal(kindOf("/videos/a.MOV"), "video")
  })

  it("treats anything it does not recognise as video, which is where it will fail loudly", () => {
    // Guessing "image" for an unknown extension would send it down a path that cannot
    // report per-frame progress. The demuxer refuses it either way; this refuses it
    // where the error message is about the file.
    assert.equal(kindOf("/x/a.txt"), "video")
    assert.equal(kindOf("/x/noextension"), "video")
  })
})
