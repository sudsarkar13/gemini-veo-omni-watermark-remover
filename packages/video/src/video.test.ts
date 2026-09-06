import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, describe, it } from "node:test"

import { blend, scaleAlphaMap, syntheticDiamond, type Frame, type Rect } from "@gvowr/engine"

import { decodeFrames } from "./decode.ts"
import { encodeFrames } from "./encode.ts"
import { resolveBinaries } from "./ffmpeg.ts"
import { resolveWindow } from "./filmstrip.ts"
import { parseManualMark } from "./cli.ts"
import { parseRational, probe } from "./probe.ts"
import { processVideo } from "./process.ts"

/**
 * These exercise the real FFmpeg binaries rather than a mock. Mocking a subprocess
 * pipe would test our mock, not the byte framing, the backpressure, or the argument
 * construction — which is where this layer actually goes wrong.
 */

let ffmpegAvailable = false
before(async () => {
  try {
    await resolveBinaries()
    ffmpegAvailable = true
  } catch {
    ffmpegAvailable = false
  }
})

const MARK: Rect = { x: 150, y: 90, width: 32, height: 32 }
const TEMPLATE = syntheticDiamond(32)
const WIDTH = 256
const HEIGHT = 160
const FRAMES = 24

function scene(seed: number): Frame {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 3)
  let state = (0x9e3779b1 ^ seed) >>> 0
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    const base = 70 + Math.round(60 * ((i % WIDTH) / WIDTH)) + ((state >>> 26) & 0x1f)
    data[i * 3] = base
    data[i * 3 + 1] = base
    data[i * 3 + 2] = base
  }
  return { width: WIDTH, height: HEIGHT, channels: 3, data }
}

function marked(seed: number): Frame {
  const frame = scene(seed)
  blend(frame, scaleAlphaMap(TEMPLATE, MARK.width, MARK.height), MARK, { gain: 0.85 })
  return frame
}

async function* generate(fn: (i: number) => Frame): AsyncGenerator<Frame, void, undefined> {
  for (let i = 0; i < FRAMES; i++) yield fn(i)
}

const INFO = {
  width: WIDTH,
  height: HEIGHT,
  frameRate: 24,
  durationSeconds: FRAMES / 24,
  frameCount: FRAMES,
  videoCodec: "rawvideo",
  pixelFormat: "rgb24",
  bitRate: null,
  hasAudio: false,
  audioCodec: null,
}

/** Lossless so the test measures our pipeline rather than h264 generation loss. */
async function makeClip(path: string, fn: (i: number) => Frame): Promise<void> {
  await encodeFrames(generate(fn), INFO, path, { crf: 0, preset: "ultrafast" })
}

describe("parseRational", () => {
  it("parses ffmpeg's rational frame rates", () => {
    assert.equal(parseRational("30/1"), 30)
    assert.ok(Math.abs(parseRational("30000/1001") - 29.97) < 0.01)
    assert.equal(parseRational("25"), 25)
  })

  it("returns 0 for missing or degenerate values rather than NaN", () => {
    assert.equal(parseRational(undefined), 0)
    assert.equal(parseRational("0/0"), 0)
    assert.equal(parseRational("abc"), 0)
  })
})

describe("ffmpeg round trip", () => {
  it("encodes frames and probes them back with the right shape", async (t) => {
    if (!ffmpegAvailable) return t.skip("ffmpeg not available")
    const dir = await mkdtemp(join(tmpdir(), "gvowr-video-"))
    const clip = join(dir, "clean.mp4")
    await makeClip(clip, scene)

    const info = await probe(clip)
    assert.equal(info.width, WIDTH)
    assert.equal(info.height, HEIGHT)
    assert.equal(info.videoCodec, "h264")
    assert.ok(Math.abs(info.frameRate - 24) < 0.1)
    assert.equal(info.hasAudio, false)
  })

  it("decodes exactly the frames that were encoded", async (t) => {
    if (!ffmpegAvailable) return t.skip("ffmpeg not available")
    const dir = await mkdtemp(join(tmpdir(), "gvowr-video-"))
    const clip = join(dir, "clean.mp4")
    await makeClip(clip, scene)

    let count = 0
    for await (const frame of decodeFrames(clip)) {
      assert.equal(frame.width, WIDTH)
      assert.equal(frame.height, HEIGHT)
      assert.equal(frame.channels, 3)
      // Frame framing is the thing most likely to be subtly wrong: ffmpeg's stdout
      // chunks have nothing to do with frame boundaries.
      assert.equal(frame.data.length, WIDTH * HEIGHT * 3)
      count++
    }
    assert.equal(count, FRAMES)
  })

  it("honours a decode limit instead of reading the whole clip", async (t) => {
    if (!ffmpegAvailable) return t.skip("ffmpeg not available")
    const dir = await mkdtemp(join(tmpdir(), "gvowr-video-"))
    const clip = join(dir, "clean.mp4")
    await makeClip(clip, scene)

    let count = 0
    for await (const _frame of decodeFrames(clip, undefined, { limit: 5 })) count++
    assert.equal(count, 5)
  })

  it("stops cleanly when the consumer breaks early", async (t) => {
    if (!ffmpegAvailable) return t.skip("ffmpeg not available")
    const dir = await mkdtemp(join(tmpdir(), "gvowr-video-"))
    const clip = join(dir, "clean.mp4")
    await makeClip(clip, scene)

    // An early break must kill the child rather than leaving it writing into a pipe
    // nobody reads, and must not surface as an unhandled rejection.
    for await (const _frame of decodeFrames(clip)) break
    await new Promise((r) => setTimeout(r, 50))
  })
})

describe("processVideo", () => {
  it("removes a watermark from a real video file end to end", async (t) => {
    if (!ffmpegAvailable) return t.skip("ffmpeg not available")
    const dir = await mkdtemp(join(tmpdir(), "gvowr-video-"))
    const dirty = join(dir, "marked.mp4")
    const cleaned = join(dir, "cleaned.mp4")
    await makeClip(dirty, marked)

    const result = await processVideo(dirty, cleaned, TEMPLATE, { sizes: [32] })

    assert.equal(result.framesWritten, FRAMES)
    assert.ok(result.plan.tracks.length >= 1, "no watermark track found in the clip")
    assert.ok(result.framesCorrected > FRAMES / 2, `only corrected ${result.framesCorrected} frames`)

    const before = await regionError(dirty, 12)
    const after = await regionError(cleaned, 12)
    assert.ok(before > 5, `fixture should be visibly marked, error was ${before.toFixed(2)}`)
    assert.ok(
      after < before * 0.4,
      `removal was weak: ${before.toFixed(2)} -> ${after.toFixed(2)}`
    )
  })

  it("leaves clean footage alone", async (t) => {
    if (!ffmpegAvailable) return t.skip("ffmpeg not available")
    const dir = await mkdtemp(join(tmpdir(), "gvowr-video-"))
    const clip = join(dir, "clean.mp4")
    const out = join(dir, "out.mp4")
    await makeClip(clip, scene)

    const result = await processVideo(clip, out, TEMPLATE, { sizes: [32] })
    assert.equal(result.plan.tracks.length, 0, "hallucinated a watermark in clean footage")
    assert.equal(result.framesWritten, FRAMES)
  })
})

/** Mean absolute error in the mark region between a clip's frame and clean truth. */
async function regionError(path: string, frameIndex: number): Promise<number> {
  let index = 0
  for await (const frame of decodeFrames(path)) {
    if (index++ !== frameIndex) continue
    const truth = scene(frameIndex)
    let total = 0
    let count = 0
    for (let y = MARK.y; y < MARK.y + MARK.height; y++) {
      for (let x = MARK.x; x < MARK.x + MARK.width; x++) {
        const i = (y * WIDTH + x) * 3
        for (let c = 0; c < 3; c++) {
          total += Math.abs((frame.data[i + c] as number) - (truth.data[i + c] as number))
          count++
        }
      }
    }
    return count > 0 ? total / count : 0
  }
  throw new Error(`frame ${frameIndex} not found in ${path}`)
}

describe("parseManualMark", () => {
  it("reads a region and the frames it applies to", () => {
    assert.deepEqual(parseManualMark("793,639,50,50@235-239"), {
      rect: { x: 793, y: 639, width: 50, height: 50 },
      fromFrame: 235,
      toFrame: 239,
    })
  })

  it("tolerates spacing", () => {
    assert.deepEqual(parseManualMark(" 10 , 20 , 30 , 40 @ 0 - 5 "), {
      rect: { x: 10, y: 20, width: 30, height: 40 },
      fromFrame: 0,
      toFrame: 5,
    })
  })

  it("refuses anything it cannot read rather than guessing", () => {
    // A misread region removes pixels somewhere nobody asked for.
    assert.throws(() => parseManualMark("793,639,50@235-239"), /x,y,w,h/)
    assert.throws(() => parseManualMark("793,639,50,50"), /x,y,w,h/)
    assert.throws(() => parseManualMark("a,b,c,d@1-2"), /x,y,w,h/)
    assert.throws(() => parseManualMark("1,2,0,4@1-2"), /positive/)
    assert.throws(() => parseManualMark("1,2,3,4@5-1"), /backwards/)
  })
})

describe("resolveWindow", () => {
  const CLIP = 10
  const FPS = 24

  it("defaults to the whole clip", () => {
    assert.deepEqual(resolveWindow(CLIP, FPS, {}), { start: 0, duration: 10 })
  })

  it("keeps a window that fits", () => {
    assert.deepEqual(resolveWindow(CLIP, FPS, { startSeconds: 9, durationSeconds: 1 }), {
      start: 9,
      duration: 1,
    })
  })

  it("trims a window that runs past the end rather than asking for frames that do not exist", () => {
    assert.deepEqual(resolveWindow(CLIP, FPS, { startSeconds: 9.5, durationSeconds: 4 }), {
      start: 9.5,
      duration: 0.5,
    })
  })

  it("clamps a start beyond the clip to its last frame", () => {
    // Not an error: the timeline can ask for a window around a playhead sitting on the
    // final frame, and an empty strip there would read as "no preview available".
    const window = resolveWindow(CLIP, FPS, { startSeconds: 99, durationSeconds: 2 })
    assert.ok(window.start > 9.9 && window.start < 10)
    assert.equal(Math.round(window.duration * 1000), Math.round((1 / FPS) * 1000))
  })

  it("floors a sub-frame window at one frame", () => {
    // Zero would divide by zero in the fps filter and come back as an empty strip.
    const window = resolveWindow(CLIP, FPS, { startSeconds: 5, durationSeconds: 0 })
    assert.equal(Math.round(window.duration * 1000), Math.round((1 / FPS) * 1000))
  })

  it("survives a clip whose frame rate was never established", () => {
    const window = resolveWindow(CLIP, 0, { startSeconds: 5, durationSeconds: 0 })
    assert.ok(window.duration > 0)
  })
})
