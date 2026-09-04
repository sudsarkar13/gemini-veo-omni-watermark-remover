import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"

import { loadTemplatePpm, syntheticDiamond, type AlphaMap } from "@gvowr/engine"

import { probe } from "./probe.ts"
import { processVideo } from "./process.ts"
import type { EncoderChoice } from "./encode.ts"

const USAGE = `gvowr-video — watermark removal for video files

Usage:
  gvowr-video probe <input>                 Report container and stream metadata
  gvowr-video clean <input> <output>        Remove watermarks and re-encode

Options:
  --template <file.ppm>   Alpha template capture (default: synthetic stand-in)
  --size <n>              Synthetic template size in pixels (48)
  --mode <auto|corner|sweep>   Detection strategy (auto)
  --sweep-interval <n>    Frames between full-frame sweeps (15)
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
      "sweep-interval": { type: "string" },
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
        `  audio: ${result.audioCopied ? "copied unchanged" : "none"}\n`
    )
    if (result.framesLeftUntouched > 0) {
      process.stdout.write(
        `  note: ${result.framesLeftUntouched} frame(s) left untouched where the mark ` +
          `could not be located\n`
      )
    }
    return 0
  }

  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
  return 1
}

async function loadTemplate(path: string | undefined, size: string | undefined): Promise<AlphaMap> {
  if (path) return loadTemplatePpm(await readFile(resolve(path)))
  return syntheticDiamond(size ? Number(size) : 48)
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
