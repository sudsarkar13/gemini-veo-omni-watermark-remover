import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, describe, it } from "node:test"

import { blend, scaleAlphaMap, syntheticDiamond, type Frame, type Rect } from "@gvowr/engine"

import { decodeFrames } from "./decode.ts"
import { encodeFrames } from "./encode.ts"
import { resolveBinaries } from "./ffmpeg.ts"
import { resolveWindow } from "./filmstrip.ts"
import {
  decodeImage,
  encodeImage,
  imageFormatFor,
  probeImage,
  processImage,
  type ImageInfo,
} from "./image.ts"
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

/**
 * Still images through the same engine.
 *
 * These write and read real files with the real binaries, because everything that can
 * go wrong here is at that boundary: a pixel format silently dropped, an alpha channel
 * quietly discarded, a codec that this build of FFmpeg does not have.
 */
describe("images", () => {
  const IMAGE_WIDTH = 320
  const IMAGE_HEIGHT = 200
  const IMAGE_MARK: Rect = { x: 200, y: 100, width: 40, height: 40 }
  /**
   * Full strength, as a real mark is.
   *
   * At 0.85 this fixture scores 0.58 against the template and falls just under the
   * discovery bar — which is correct behaviour, not a bug: a single frame has no
   * neighbours to corroborate it, so a weak correlation peak is exactly what the bar
   * exists to refuse. The real Veo mark measures alpha 1.00, so the fixture does too.
   */
  const IMAGE_GAIN = 1

  function picture(alpha: number | null): Frame {
    const channels = alpha === null ? 3 : 4
    const data = new Uint8ClampedArray(IMAGE_WIDTH * IMAGE_HEIGHT * channels)
    let state = 0x9e3779b1
    for (let i = 0; i < IMAGE_WIDTH * IMAGE_HEIGHT; i++) {
      state = (state * 1664525 + 1013904223) >>> 0
      const base = 70 + Math.round(50 * ((i % IMAGE_WIDTH) / IMAGE_WIDTH)) + ((state >>> 26) & 0x1f)
      const o = i * channels
      data[o] = base
      data[o + 1] = base
      data[o + 2] = base
      if (alpha !== null) data[o + 3] = alpha
    }
    return { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, channels: channels as 3 | 4, data }
  }

  function stamped(alpha: number | null): Frame {
    const frame = picture(alpha)
    blend(frame, scaleAlphaMap(syntheticDiamond(40), 40, 40), IMAGE_MARK, { gain: IMAGE_GAIN })
    return frame
  }

  function infoFor(frame: Frame): ImageInfo {
    return {
      width: frame.width,
      height: frame.height,
      codec: "png",
      pixelFormat: frame.channels === 4 ? "rgba" : "rgb24",
      format: "png",
      hasAlpha: frame.channels === 4,
      sizeBytes: 0,
      lossyRoundTrip: false,
    }
  }

  it("removes a mark from a still and leaves every other pixel alone", async (t) => {
    if (!ffmpegAvailable) return t.skip("ffmpeg not available")
    const dir = await mkdtemp(join(tmpdir(), "gvowr-image-"))
    const input = join(dir, "marked.png")
    const output = join(dir, "clean.png")

    const source = stamped(null)
    await encodeImage(source, input, infoFor(source))
    const before = await decodeImage(input)

    const result = await processImage(input, output, syntheticDiamond(40))
    assert.equal(result.written, true, `nothing was written: ${result.reason}`)
    assert.equal(result.applied, 1)

    const after = await decodeImage(output)
    const original = picture(null)

    // Inside the mark: back towards what was underneath it. Measured as mean absolute
    // error against the truth, the same way the video end-to-end test measures it —
    // a worst-pixel metric is dominated by the one pixel at the edge of a rect the
    // detector sized to 38 rather than 40, which says nothing about the removal.
    const markError = (frame: Frame): number => {
      let sum = 0
      let count = 0
      for (let row = IMAGE_MARK.y; row < IMAGE_MARK.y + IMAGE_MARK.height; row++) {
        for (let col = IMAGE_MARK.x; col < IMAGE_MARK.x + IMAGE_MARK.width; col++) {
          const index = row * IMAGE_WIDTH + col
          sum += Math.abs(
            (frame.data[index * frame.channels] as number) - (original.data[index * 3] as number)
          )
          count++
        }
      }
      return sum / count
    }

    const errorBefore = markError(before)
    const errorAfter = markError(after)
    assert.ok(errorBefore > 5, `fixture should be visibly marked, error was ${errorBefore.toFixed(2)}`)
    assert.ok(
      errorAfter < errorBefore * 0.25,
      `removal was weak: ${errorBefore.toFixed(2)} -> ${errorAfter.toFixed(2)}`
    )

    // Outside it: untouched, exactly. A lossless format has no excuse for drift, and
    // "we only changed what we said we changed" is the whole claim of this tool.
    let moved = 0
    for (let row = 0; row < IMAGE_HEIGHT; row++) {
      for (let col = 0; col < IMAGE_WIDTH; col++) {
        const inside =
          row >= IMAGE_MARK.y - 2 &&
          row < IMAGE_MARK.y + IMAGE_MARK.height + 2 &&
          col >= IMAGE_MARK.x - 2 &&
          col < IMAGE_MARK.x + IMAGE_MARK.width + 2
        if (inside) continue
        const index = (row * IMAGE_WIDTH + col) * 4
        if (before.data[index] !== after.data[index]) moved++
      }
    }
    assert.equal(moved, 0, `${moved} pixels outside the mark changed`)
  })

  it("carries a transparency channel through untouched", async (t) => {
    if (!ffmpegAvailable) return t.skip("ffmpeg not available")
    const dir = await mkdtemp(join(tmpdir(), "gvowr-image-alpha-"))
    const input = join(dir, "marked.png")
    const output = join(dir, "clean.png")

    const source = stamped(128)
    await encodeImage(source, input, infoFor(source))

    const result = await processImage(input, output, syntheticDiamond(40))
    assert.equal(result.written, true, `nothing was written: ${result.reason}`)

    const after = await decodeImage(output)
    assert.equal(after.channels, 4)
    for (let i = 3; i < after.data.length; i += 4) {
      assert.equal(after.data[i], 128, `alpha changed at byte ${i}`)
    }
    assert.equal((await probeImage(output)).hasAlpha, true)
  })

  it("writes nothing at all when there is no mark to remove", async (t) => {
    if (!ffmpegAvailable) return t.skip("ffmpeg not available")
    const dir = await mkdtemp(join(tmpdir(), "gvowr-image-clean-"))
    const input = join(dir, "plain.png")
    const output = join(dir, "out.png")

    const source = picture(null)
    await encodeImage(source, input, infoFor(source))

    const result = await processImage(input, output, syntheticDiamond(40))
    assert.equal(result.written, false)
    assert.equal(result.reason, "no-mark-found")
    // An image with one bad frame is a bad image. Better to leave the original alone
    // than to hand back a copy that quietly changed nothing.
    assert.equal(existsSync(output), false)
  })

  it("refuses an output named as a different format rather than writing a mislabelled file", async (t) => {
    if (!ffmpegAvailable) return t.skip("ffmpeg not available")
    const dir = await mkdtemp(join(tmpdir(), "gvowr-image-format-"))
    const input = join(dir, "marked.png")
    const source = stamped(null)
    await encodeImage(source, input, infoFor(source))

    await assert.rejects(
      () => processImage(input, join(dir, "clean.webp"), syntheticDiamond(40)),
      /written back as png/
    )
  })

  it("knows which extensions it reads", () => {
    assert.equal(imageFormatFor("a.png"), "png")
    assert.equal(imageFormatFor("a.JPG"), "jpeg")
    assert.equal(imageFormatFor("a.jpeg"), "jpeg")
    assert.equal(imageFormatFor("a.webp"), "webp")
    assert.equal(imageFormatFor("a.mp4"), null)
    assert.equal(imageFormatFor("a"), null)
  })
})
