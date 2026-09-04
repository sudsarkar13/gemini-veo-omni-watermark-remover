/**
 * Derives a watermark alpha template from a clip that carries the mark.
 *
 * The mark is composited as a constant overlay: `observed = source·(1−α) + 255·α`.
 * Over a clip whose content moves behind it, the per-pixel minimum across frames is
 * taken where the source was darkest; wherever the source reaches black at least once,
 * that minimum *is* `255·α`. A low percentile rather than the strict minimum keeps
 * codec noise from biasing every pixel down by a couple of levels.
 *
 * This only works on a clip whose background under the mark goes properly dark, which
 * is why the result is checked against a flat-plateau expectation before being kept.
 * See docs/PLAN.md §2 and §9.
 *
 *   node scripts/derive-template.mjs <clip> <x> <y> <size> <out.ppm>
 */
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"

const [clip, xs, ys, sizes, out] = process.argv.slice(2)
if (!clip || !out) {
  console.error("usage: derive-template.mjs <clip> <x> <y> <size> <out.ppm>")
  process.exit(1)
}
const x = Number(xs)
const y = Number(ys)
const size = Number(sizes)

/**
 * A low order statistic rather than the strict minimum: the minimum is where the
 * background was darkest, but a single codec-noise sample would drag every pixel down
 * with it. The first percentile is still comfortably inside the dark frames.
 */
const PERCENTILE = 0.01

const chunks = []
const ff = spawn("ffmpeg", [
  "-v", "error",
  "-i", clip,
  "-vf", `format=gray,crop=${size}:${size}:${x}:${y}`,
  "-f", "rawvideo", "-pix_fmt", "gray", "-",
])
ff.stdout.on("data", (c) => chunks.push(c))
ff.stderr.on("data", (c) => process.stderr.write(c))
await new Promise((resolve, reject) => {
  ff.on("error", reject)
  ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
})

const data = Buffer.concat(chunks)
const pixels = size * size
const frames = data.length / pixels
if (!Number.isInteger(frames) || frames < 30) {
  throw new Error(`expected at least 30 whole frames, decoded ${frames}`)
}

const floorAt = new Uint8Array(pixels)
const column = new Uint8Array(frames)
for (let i = 0; i < pixels; i++) {
  for (let f = 0; f < frames; f++) column[f] = data[f * pixels + i]
  const sorted = Uint8Array.prototype.slice.call(column).sort()
  floorAt[i] = sorted[Math.floor(PERCENTILE * (frames - 1))]
}

/*
 * The darkest the source ever gets is not quite zero — black level, dither and codec
 * noise leave a floor of a level or two. Measuring that floor on the border, where
 * there is no mark, and inverting `v = b·(1−α) + 255·α` against it keeps that floor
 * from being read as a faint watermark covering the whole tile.
 */
const border = []
for (let i = 0; i < size; i++) {
  border.push(floorAt[i], floorAt[(size - 1) * size + i], floorAt[i * size], floorAt[i * size + size - 1])
}
border.sort((a, b) => a - b)
const backgroundFloor = border[Math.floor(border.length / 2)]

const alpha = new Uint8Array(pixels)
for (let i = 0; i < pixels; i++) {
  const v = (floorAt[i] - backgroundFloor) / (255 - backgroundFloor)
  alpha[i] = Math.max(0, Math.min(255, Math.round(v * 255)))
}

const header = Buffer.from(`P6\n${size} ${size}\n255\n`)
const rgb = Buffer.alloc(pixels * 3)
for (let i = 0; i < pixels; i++) rgb.fill(alpha[i], i * 3, i * 3 + 3)
writeFileSync(out, Buffer.concat([header, rgb]))

let peak = 0
let covered = 0
for (const v of alpha) {
  if (v > peak) peak = v
  if (v > peak * 0.5) covered++
}
console.log(
  JSON.stringify(
    {
      frames,
      size,
      backgroundFloor,
      peak,
      peakAlpha: +(peak / 255).toFixed(4),
      coveredPixels: covered,
      out,
    },
    null,
    2
  )
)
