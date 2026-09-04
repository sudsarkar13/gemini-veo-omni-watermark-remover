import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { main, parseMode, parseRegion } from "./cli.ts"
import { decodePpm, encodePpm } from "./ppm.ts"
import type { Frame, Rect } from "./types.ts"

function scene(width: number, height: number, seed: number): Frame {
  const data = new Uint8ClampedArray(width * height * 3)
  let state = (0x9e3779b1 ^ seed) >>> 0
  for (let i = 0; i < width * height; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    const base = 70 + Math.round(60 * ((i % width) / width)) + ((state >>> 25) & 0x3f)
    data[i * 3] = base
    data[i * 3 + 1] = base
    data[i * 3 + 2] = base
  }
  return { width, height, channels: 3, data }
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "gvowr-"))
}

describe("argument parsing", () => {
  it("parses a region", () => {
    assert.deepEqual(parseRegion("10,20,30,40"), { x: 10, y: 20, width: 30, height: 40 })
    assert.deepEqual(parseRegion(" 1 , 2 , 3 , 4 "), { x: 1, y: 2, width: 3, height: 4 })
  })

  it("rejects malformed regions rather than acting on garbage", () => {
    assert.throws(() => parseRegion("1,2,3"), /x,y,w,h/)
    assert.throws(() => parseRegion("a,b,c,d"), /x,y,w,h/)
    assert.throws(() => parseRegion("1,2,0,4"), /positive/)
  })

  it("parses and validates the detection mode", () => {
    assert.equal(parseMode(undefined), "auto")
    assert.equal(parseMode("sweep"), "sweep")
    assert.throws(() => parseMode("magic"), /auto, corner or sweep/)
  })
})

describe("stamp and clean round trip", () => {
  it("removes a mark it stamped, recovering most of the original", () => {
    // The end-to-end claim of the whole tool, exercised through the CLI surface.
    return (async () => {
      const dir = await workspace()
      const original = join(dir, "original.ppm")
      const marked = join(dir, "marked.ppm")
      const cleaned = join(dir, "cleaned.ppm")

      const source = scene(160, 160, 3)
      await writeFile(original, encodePpm(source))

      assert.equal(
        await main(["stamp", original, marked, "--region", "60,60,32,32", "--gain", "0.85"]),
        0
      )
      assert.equal(await main(["clean", marked, cleaned, "--region", "60,60,32,32"]), 0)

      const dirty = decodePpm(await readFile(marked))
      const fixed = decodePpm(await readFile(cleaned))

      const marks: Rect = { x: 60, y: 60, width: 32, height: 32 }
      const before = meanError(dirty, source, marks)
      const after = meanError(fixed, source, marks)
      assert.ok(before > 5, `fixture should be visibly marked, error was ${before}`)
      assert.ok(after < before * 0.3, `cleaning barely helped: ${before.toFixed(1)} -> ${after.toFixed(1)}`)
    })()
  })

  it("reports failure when asked to stamp without a region", async () => {
    const dir = await workspace()
    const input = join(dir, "in.ppm")
    await writeFile(input, encodePpm(scene(32, 32, 1)))
    assert.equal(await main(["stamp", input, join(dir, "out.ppm")]), 1)
  })
})

describe("sequence", () => {
  it("plans and cleans a whole frame directory", async () => {
    const dir = await workspace()
    const from = join(dir, "frames")
    const to = join(dir, "out")
    await mkdir(from, { recursive: true })

    const region = { x: 90, y: 100, width: 24, height: 24 }
    const originals: Frame[] = []
    for (let i = 0; i < 16; i++) {
      const frame = scene(176, 176, i)
      originals.push({ ...frame, data: Uint8ClampedArray.from(frame.data) })
      await writeFile(join(from, `f${String(i).padStart(4, "0")}.ppm`), encodePpm(frame))
    }
    // Stamp every frame through the CLI so the fixture matches real input.
    for (let i = 0; i < 16; i++) {
      const name = `f${String(i).padStart(4, "0")}.ppm`
      await main([
        "stamp",
        join(from, name),
        join(from, name),
        "--region",
        `${region.x},${region.y},${region.width},${region.height}`,
        "--gain",
        "0.85",
      ])
    }

    assert.equal(await main(["sequence", from, to, "--size", "24"]), 0)

    const cleaned = decodePpm(await readFile(join(to, "f0008.ppm")))
    const marked = decodePpm(await readFile(join(from, "f0008.ppm")))
    const before = meanError(marked, originals[8] as Frame, region)
    const after = meanError(cleaned, originals[8] as Frame, region)
    assert.ok(after < before * 0.15, `sequence cleaning weak: ${before.toFixed(2)} -> ${after.toFixed(2)}`)
  })

  it("fails clearly on a directory with no frames", async () => {
    const dir = await workspace()
    await mkdir(join(dir, "empty"), { recursive: true })
    assert.equal(await main(["sequence", join(dir, "empty"), join(dir, "out")]), 1)
  })
})

describe("cli surface", () => {
  it("prints usage and fails when given no command", async () => {
    assert.equal(await main([]), 1)
  })

  it("rejects an unknown command", async () => {
    assert.equal(await main(["frobnicate"]), 1)
  })
})

/**
 * Mean absolute channel error over a region.
 *
 * Scoped to the marked region deliberately: the mark covers a few percent of the
 * frame, so a whole-frame average dilutes the very signal under test by more than an
 * order of magnitude and turns a real regression into noise.
 */
function meanError(a: Frame, b: Frame, region: Rect): number {
  let total = 0
  let count = 0
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      const i = (y * a.width + x) * 3
      for (let c = 0; c < 3; c++) {
        total += Math.abs((a.data[i + c] as number) - (b.data[i + c] as number))
        count++
      }
    }
  }
  return count > 0 ? total / count : 0
}
