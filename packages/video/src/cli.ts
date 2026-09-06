import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"

import {
  defaultTemplate,
  loadTemplatePpm,
  syntheticDiamond,
  type AlphaMap,
  type ManualMark,
} from "@gvowr/engine"

import { processImage } from "./image.ts"
import { probe } from "./probe.ts"
import { processVideo } from "./process.ts"
import type { EncoderChoice } from "./encode.ts"

const USAGE = `gvowr-video — watermark removal for video files

Usage:
  gvowr-video probe <input>                 Report container and stream metadata
  gvowr-video clean <input> <output>        Remove watermarks and re-encode
  gvowr-video image <input> <output>        Remove the watermark from a still
                                            (.png .jpg .jpeg .webp; the output must
                                            name the same format as the input)

Options:
  --template <file.ppm>   Alpha template capture (default: measured Veo capture)
  --size <n>              Use the synthetic stand-in at this size instead
  --mode <auto|corner|sweep>   Detection strategy (auto)
  --manual <x,y,w,h@from-to>   Region the mark occupies over a frame range.
                          Repeatable. Seeds the search where you say the mark is;
                          tracking follows it from there.
  --sweep-interval <n>    Frames between full-frame sweeps (15)
  --fill                  Synthesise pixels for regions the exact path declined.
                          Off by default. Invents rather than recovers, so what it
                          touches is reported as "filled", never as corrected.
  --crf <n>               Quality, lower is better (14)
  --preset <name>         x264 preset (slow)
  --encoder <auto|software|hardware>
  --json                  Machine-readable output
`

export async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      template: { type: "string" },
      size: { type: "string" },
      mode: { type: "string" },
      manual: { type: "string", multiple: true },
      "sweep-interval": { type: "string" },
      fill: { type: "boolean", default: false },
      crf: { type: "string" },
      preset: { type: "string" },
      encoder: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })

  const [command, ...args] = positionals
  if (values.help || !command) {
    process.stdout.write(USAGE)
    return command ? 0 : 1
  }

  const json = values.json === true

  if (command === "probe") {
    const [input] = args
    if (!input) throw new Error("usage: gvowr-video probe <input>")
    const info = await probe(resolve(input))
    if (json) {
      process.stdout.write(JSON.stringify(info, null, 2) + "\n")
    } else {
      process.stdout.write(
        `${info.width}x${info.height} ${info.videoCodec} ${info.pixelFormat}\n` +
          `  ${info.frameRate.toFixed(3)} fps, ${info.durationSeconds.toFixed(2)}s, ` +
          `${info.frameCount} frames\n` +
          `  audio: ${info.hasAudio ? (info.audioCodec ?? "present") : "none"}\n`
      )
    }
    return 0
  }

  if (command === "clean") {
    const [input, output] = args
    if (!input || !output) throw new Error("usage: gvowr-video clean <input> <output>")

    const template = await loadTemplate(values.template, values.size)
    let lastPercent = -1

    const result = await processVideo(resolve(input), resolve(output), template, {
      mode: parseMode(values.mode),
      ...(values.fill ? { fill: true } : {}),
      ...(values.manual ? { manualMarks: values.manual.map(parseManualMark) } : {}),
      ...(values["sweep-interval"] ? { sweepInterval: Number(values["sweep-interval"]) } : {}),
      ...(values.crf ? { crf: Number(values.crf) } : {}),
      ...(values.preset ? { preset: values.preset } : {}),
      ...(values.encoder ? { encoder: parseEncoder(values.encoder) } : {}),
      ...(json
        ? {}
        : {
            onAnalyseProgress: (frame: number, total: number) => {
              lastPercent = report("analysing", frame, total, lastPercent)
            },
            onRenderProgress: (frame: number, total: number) => {
              lastPercent = report("rendering", frame, total, lastPercent)
            },
          }),
    })

    if (!json) process.stderr.write("\n")

    if (json) {
      process.stdout.write(
        JSON.stringify(
          {
            ...result.plan.diagnostics,
            framesWritten: result.framesWritten,
            framesCorrected: result.framesCorrected,
            framesLeftUntouched: result.framesLeftUntouched,
            framesFilled: result.framesFilled,
            coverage: result.coverage,
            audioCopied: result.audioCopied,
          },
          null,
          2
        ) + "\n"
      )
      return 0
    }

    const d = result.plan.diagnostics
    process.stdout.write(
      `${result.framesWritten} frames at ${d.width}x${d.height} -> ${output}\n` +
        `  resolution calibrated: ${d.calibratedResolution ? "yes" : "no (using a generic prior)"}\n` +
        `  tracks kept ${result.plan.tracks.length}, rejected ${d.tracksRejected}\n` +
        `  corrections applied ${result.framesCorrected}\n` +
        (result.framesFilled > 0
          ? `  regions FILLED (synthesised, not recovered) ${result.framesFilled}\n`
          : "") +
        `  audio: ${result.audioCopied ? "copied unchanged" : "none"}\n`
    )
    if (result.framesLeftUntouched > 0) {
      process.stdout.write(
        `  note: ${result.framesLeftUntouched} frame(s) left untouched where the mark ` +
          `was covered\n`
      )
    }
    // Said plainly and last, because it is the one number that means the output is
    // not clean. Burying it would make the summary above a lie by omission.
    if (result.coverage.framesUncovered > 0) {
      const ranges = result.coverage.gaps
        .map((gap) => (gap.from === gap.to ? `${gap.from}` : `${gap.from}-${gap.to}`))
        .join(", ")
      process.stdout.write(
        `  WARNING: ${result.coverage.framesUncovered} frame(s) still carry the mark. ` +
          `The track was lost at ${ranges} and nothing was applied there.\n`
      )
      return 2
    }
    return 0
  }

  if (command === "image") {
    const [input, output] = args
    if (!input || !output) throw new Error("usage: gvowr-video image <input> <output>")

    const template = await loadTemplate(values.template, values.size)
    const result = await processImage(resolve(input), resolve(output), template, {
      mode: parseMode(values.mode),
      ...(values.fill ? { fill: true } : {}),
      ...(values.manual ? { manualMarks: values.manual.map(parseManualMark) } : {}),
    })

    if (json) {
      process.stdout.write(
        JSON.stringify(
          {
            ...result.plan.diagnostics,
            format: result.info.format,
            hasAlpha: result.info.hasAlpha,
            lossyRoundTrip: result.info.lossyRoundTrip,
            regions: result.regions,
            applied: result.applied,
            skipped: result.skipped,
            filled: result.filled,
            written: result.written,
            reason: result.reason,
          },
          null,
          2
        ) + "\n"
      )
      // Nothing written is not success, whatever the exit code of a JSON run implies.
      return result.written ? 0 : 2
    }

    const info = result.info
    process.stdout.write(
      `${info.width}x${info.height} ${info.codec} ${info.pixelFormat}` +
        `${info.hasAlpha ? " (transparent)" : ""}\n`
    )

    if (!result.written) {
      // The original is untouched and no file was written. Said as a refusal rather
      // than a result, because an image with one bad region is a bad image.
      process.stdout.write(
        result.reason === "no-mark-found"
          ? `  no watermark found — nothing was written, the original is untouched\n`
          : `  a mark was found but could not be inverted into its surroundings — ` +
              `nothing was written, the original is untouched\n`
      )
      return 2
    }

    for (const region of result.regions) {
      process.stdout.write(
        `  removed ${region.rect.width}px mark at ${region.rect.x},${region.rect.y} ` +
          `(alpha ${region.alpha.toFixed(2)}, score ${region.confidence.toFixed(2)})\n`
      )
    }
    if (result.filled > 0) {
      // Named as invention every time it is mentioned. This is the one part of the
      // output the tool cannot vouch for.
      process.stdout.write(
        `  FILLED ${result.filled} region(s) — pixels synthesised from the surroundings, ` +
          `not recovered\n`
      )
    }
    process.stdout.write(`  written to ${output}\n`)
    if (info.lossyRoundTrip) {
      process.stdout.write(
        `  note: a JPEG cannot be edited in place, so the whole image was re-encoded ` +
          `at maximum quality. Pixels outside the mark change slightly.\n`
      )
    }
    return 0
  }

  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
  return 1
}

/** `x,y,w,h@from-to` — the region, then the inclusive frame range it applies to. */
export function parseManualMark(text: string): ManualMark {
  const [box, range] = text.split("@")
  if (!box || !range) throw new Error(`manual region must be x,y,w,h@from-to, got "${text}"`)

  const parts = box.split(",").map((p) => Number(p.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`manual region must be x,y,w,h@from-to, got "${text}"`)
  }
  const [x, y, width, height] = parts as [number, number, number, number]
  if (width <= 0 || height <= 0) throw new Error(`manual region size must be positive, got "${text}"`)

  const bounds = range.split("-").map((p) => Number(p.trim()))
  if (bounds.length !== 2 || bounds.some((n) => !Number.isInteger(n))) {
    throw new Error(`manual region range must be from-to, got "${text}"`)
  }
  const [fromFrame, toFrame] = bounds as [number, number]
  if (toFrame < fromFrame) throw new Error(`manual region range runs backwards: "${text}"`)

  return { rect: { x, y, width, height }, fromFrame, toFrame }
}

async function loadTemplate(path: string | undefined, size: string | undefined): Promise<AlphaMap> {
  if (path) return loadTemplatePpm(await readFile(resolve(path)))
  // --size selects the synthetic stand-in deliberately; without it the measured
  // capture is used, which is the only template that actually removes the mark.
  return size ? syntheticDiamond(Number(size)) : defaultTemplate()
}

function report(stage: string, frame: number, total: number, lastPercent: number): number {
  if (total <= 0) return lastPercent
  const percent = Math.floor((frame / total) * 100)
  if (percent === lastPercent) return lastPercent
  process.stderr.write(`\r${stage} ${percent}% (${frame}/${total})   `)
  return percent
}

export function parseMode(value: string | undefined): "auto" | "corner" | "sweep" {
  if (value === undefined) return "auto"
  if (value === "auto" || value === "corner" || value === "sweep") return value
  throw new Error(`--mode expects auto, corner or sweep but got "${value}"`)
}

export function parseEncoder(value: string): EncoderChoice {
  if (value === "auto" || value === "software" || value === "hardware") return value
  throw new Error(`--encoder expects auto, software or hardware but got "${value}"`)
}
