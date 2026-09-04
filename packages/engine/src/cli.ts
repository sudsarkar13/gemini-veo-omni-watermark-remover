import { readFile, readdir, writeFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

import { scaleAlphaMap } from "./alpha-map.ts"
import { blend, unblend } from "./blend.ts"
import { toGrayscale } from "./correlate.ts"
import { analyseFrame, sweepFrame } from "./detect.ts"
import { planClip, renderFrame, type DetectionMode } from "./pipeline.ts"
import { decodePpm, encodePpm } from "./ppm.ts"
import { defaultTemplate, loadTemplatePpm, syntheticDiamond } from "./templates.ts"
import type { AlphaMap, Frame, Rect } from "./types.ts"
import { verifyReversibility } from "./verify.ts"

/**
 * Headless CLI for the engine.
 *
 * Deliberately built before any UI: the engine is the product, and it needs to be
 * exercisable and debuggable on its own. Works on binary PPM, which FFmpeg reads and
 * writes natively, so a whole clip can be processed today:
 *
 *   ffmpeg -i clip.mp4 frames/%06d.ppm
 *   gvowr sequence frames out
 *   ffmpeg -framerate 30 -i out/%06d.ppm -i clip.mp4 -map 0:v -map 1:a \
 *          -c:v libx264 -crf 14 -preset slow -c:a copy clean.mp4
 */

const USAGE = `gvowr — Gemini/Veo watermark engine

Usage:
  gvowr detect   <frame.ppm>                 Sweep one frame and report candidates
  gvowr clean    <in.ppm> <out.ppm>          Remove marks from a single frame
  gvowr stamp    <in.ppm> <out.ppm>          Composite a mark on (makes test material)
  gvowr sequence <in-dir> <out-dir>          Plan and clean a whole frame sequence

Options:
  --template <file.ppm>   Alpha template capture. Defaults to a synthetic diamond,
                          which is a stand-in only — see templates.ts.
  --size <n>              Template size in pixels for the synthetic default (48)
  --region <x,y,w,h>      Skip detection and act on this exact region
  --gain <n>              Fixed intensity instead of a measured one
  --mode <auto|corner|sweep>   Detection strategy (auto)
  --sweep-interval <n>    Frames between full-frame sweeps (15)
  --json                  Machine-readable output
`

export async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      template: { type: "string" },
      size: { type: "string" },
      region: { type: "string" },
      gain: { type: "string" },
      mode: { type: "string" },
      "sweep-interval": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })

  const [command, ...args] = positionals
  if (values.help || !command) {
    process.stdout.write(USAGE)
    return command ? 0 : 1
  }

  // --size only makes sense for the synthetic stand-in; the measured template is the
  // default and carries its own size, which the detector rescales per candidate.
  const template = values.template
    ? loadTemplatePpm(await readFile(resolve(values.template)))
    : values.size
      ? syntheticDiamond(Number(values.size))
      : defaultTemplate()

  const region = values.region ? parseRegion(values.region) : null
  const gain = values.gain ? Number(values.gain) : null
  const json = values.json === true

  switch (command) {
    case "detect":
      return detect(args, template, json)
    case "clean":
      return clean(args, template, region, gain, json)
    case "stamp":
      return stamp(args, template, region, gain)
    case "sequence":
      return sequence(args, template, values, json)
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
      return 1
  }
}

async function detect(args: string[], template: AlphaMap, json: boolean): Promise<number> {
  const [input] = requireArgs(args, 1, "detect <frame.ppm>")
  const frame = decodePpm(await readFile(resolve(input as string)))
  const analysis = analyseFrame(toGrayscale(frame))

  const found = sweepFrame(analysis, template).map((candidate) => {
    const scaled = scaleAlphaMap(template, candidate.rect.width, candidate.rect.height)
    const verdict = verifyReversibility(analysis.image, scaled, candidate.rect)
    return { ...candidate, verdict }
  })

  if (json) {
    process.stdout.write(JSON.stringify({ width: frame.width, height: frame.height, found }, null, 2) + "\n")
    return 0
  }

  process.stdout.write(`${frame.width}x${frame.height}, ${found.length} candidate(s)\n`)
  for (const c of found) {
    const verdict = c.verdict.inconclusive
      ? "inconclusive"
      : c.verdict.isComposite
        ? `composite, gain ${c.verdict.gain.toFixed(2)}`
        : "rejected (not reversible)"
    process.stdout.write(
      `  (${c.rect.x},${c.rect.y}) ${c.rect.width}px  score ${c.score.toFixed(3)}` +
        ` [s ${c.spatial.toFixed(2)} g ${c.gradient.toFixed(2)} v ${c.variance.toFixed(2)}]  ${verdict}\n`
    )
  }
  return found.some((c) => c.verdict.isComposite) ? 0 : 1
}

async function clean(
  args: string[],
  template: AlphaMap,
  region: Rect | null,
  gain: number | null,
  json: boolean
): Promise<number> {
  const [input, output] = requireArgs(args, 2, "clean <in.ppm> <out.ppm>")
  const frame = decodePpm(await readFile(resolve(input as string)))

  const applied = region
    ? [applyAt(frame, template, region, gain ?? measureGain(frame, template, region))]
    : autoClean(frame, template, gain)

  await writeFile(resolve(output as string), encodePpm(frame))
  if (json) process.stdout.write(JSON.stringify({ applied }, null, 2) + "\n")
  else process.stdout.write(`removed ${applied.length} mark(s) -> ${output}\n`)
  return applied.length > 0 ? 0 : 1
}

async function stamp(
  args: string[],
  template: AlphaMap,
  region: Rect | null,
  gain: number | null
): Promise<number> {
  const [input, output] = requireArgs(args, 2, "stamp <in.ppm> <out.ppm>")
  if (!region) {
    process.stderr.write("stamp requires --region x,y,w,h\n")
    return 1
  }
  const frame = decodePpm(await readFile(resolve(input as string)))
  blend(frame, scaleAlphaMap(template, region.width, region.height), region, { gain: gain ?? 1 })
  await writeFile(resolve(output as string), encodePpm(frame))
  process.stdout.write(`stamped -> ${output}\n`)
  return 0
}

async function sequence(
  args: string[],
  template: AlphaMap,
  values: { mode?: string | undefined; "sweep-interval"?: string | undefined },
  json: boolean
): Promise<number> {
  const [inputDir, outputDir] = requireArgs(args, 2, "sequence <in-dir> <out-dir>")
  const from = resolve(inputDir as string)
  const to = resolve(outputDir as string)

  const names = (await readdir(from)).filter((n) => n.toLowerCase().endsWith(".ppm")).sort()
  if (names.length === 0) {
    process.stderr.write(`no .ppm frames found in ${from}\n`)
    return 1
  }

  // Two passes over the clip, which is the whole advantage over streaming tools:
  // the correction for any frame can use evidence from frames after it.
  const load = async (name: string): Promise<Frame> => decodePpm(await readFile(join(from, name)))
  const frames: Frame[] = []
  for (const name of names) frames.push(await load(name))

  const plan = planClip(frames, template, {
    mode: parseMode(values.mode),
    ...(values["sweep-interval"] ? { sweepInterval: Number(values["sweep-interval"]) } : {}),
  })

  await mkdir(to, { recursive: true })
  let applied = 0
  let skipped = 0
  for (let i = 0; i < names.length; i++) {
    const frame = frames[i] as Frame
    const report = renderFrame(frame, plan, i, template)
    applied += report.applied
    skipped += report.skipped
    await writeFile(join(to, names[i] as string), encodePpm(frame))
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ...plan.diagnostics, applied, skipped }, null, 2) + "\n")
    return 0
  }

  const d = plan.diagnostics
  process.stdout.write(
    `${d.frameCount} frames at ${d.width}x${d.height}\n` +
      `  resolution calibrated: ${d.calibratedResolution ? "yes" : "no (using a generic prior)"}\n` +
      `  tracks kept ${plan.tracks.length}, rejected ${d.tracksRejected}\n` +
      `  frames corrected ${applied}, left untouched ${skipped}\n` +
      `  detected ${d.framesDetected}, interpolated ${d.framesInterpolated}, occluded ${d.framesOccluded}\n` +
      `  ${d.sweeps} full-frame sweeps in ${d.elapsedMs} ms\n`
  )
  if (skipped > 0) {
    process.stdout.write(`  note: ${skipped} frame(s) left untouched where the mark could not be located\n`)
  }
  return 0
}

function autoClean(frame: Frame, template: AlphaMap, gain: number | null): Rect[] {
  const analysis = analyseFrame(toGrayscale(frame))
  const applied: Rect[] = []
  for (const candidate of sweepFrame(analysis, template)) {
    const scaled = scaleAlphaMap(template, candidate.rect.width, candidate.rect.height)
    const verdict = verifyReversibility(analysis.image, scaled, candidate.rect)
    if (!verdict.isComposite) continue
    unblend(frame, scaled, candidate.rect, { gain: gain ?? verdict.gain })
    applied.push(candidate.rect)
  }
  return applied
}

function applyAt(frame: Frame, template: AlphaMap, region: Rect, gain: number): Rect {
  unblend(frame, scaleAlphaMap(template, region.width, region.height), region, { gain })
  return region
}

function measureGain(frame: Frame, template: AlphaMap, region: Rect): number {
  const scaled = scaleAlphaMap(template, region.width, region.height)
  return verifyReversibility(toGrayscale(frame), scaled, region).gain
}

export function parseMode(value: string | undefined): DetectionMode {
  if (value === undefined) return "auto"
  if (value === "auto" || value === "corner" || value === "sweep") return value
  throw new Error(`--mode expects auto, corner or sweep but got "${value}"`)
}

export function parseRegion(value: string): Rect {
  const parts = value.split(",").map((p) => Number(p.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`--region expects x,y,w,h but got "${value}"`)
  }
  const [x, y, width, height] = parts as [number, number, number, number]
  if (width <= 0 || height <= 0) throw new Error("--region width and height must be positive")
  return { x, y, width, height }
}

function requireArgs(args: string[], count: number, usage: string): string[] {
  if (args.length < count) throw new Error(`usage: gvowr ${usage}`)
  return args
}
