import {
  createPlanner,
  renderFrame,
  type AlphaMap,
  type ClipPlan,
  type Frame,
  type PlanOptions,
} from "@gvowr/engine"

import { decodeFrames } from "./decode.ts"
import { encodeFrames, type EncodeOptions } from "./encode.ts"
import { probe, type VideoInfo } from "./probe.ts"

/**
 * The full two-pass clip workflow over a real video file.
 *
 * The source is decoded twice: once to analyse, once to render. That is the cost of
 * being able to correct a frame using evidence from frames after it, and it is why
 * this tool can interpolate a mark through an occlusion where a streaming browser
 * tool has to give up.
 */

export interface ProcessOptions extends PlanOptions, EncodeOptions {
  readonly onAnalyseProgress?: (frame: number, total: number) => void
  readonly onRenderProgress?: (frame: number, total: number) => void
}

export interface ProcessResult {
  readonly info: VideoInfo
  readonly plan: ClipPlan
  readonly framesWritten: number
  readonly framesCorrected: number
  readonly framesLeftUntouched: number
  readonly audioCopied: boolean
}

export async function processVideo(
  input: string,
  output: string,
  template: AlphaMap,
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  const info = await probe(input)

  // Pass 1: analyse. Frames are consumed and discarded; only observations are kept.
  const planner = createPlanner(template, options)
  let analysed = 0
  for await (const frame of decodeFrames(input, info)) {
    planner.push(frame)
    analysed++
    options.onAnalyseProgress?.(analysed, info.frameCount)
  }
  const plan = planner.finish()

  // Pass 2: render. Decode again and apply the finished plan.
  let corrected = 0
  let untouched = 0
  let rendered = 0

  async function* corrections(): AsyncGenerator<Frame, void, undefined> {
    for await (const frame of decodeFrames(input, info)) {
      const report = renderFrame(frame, plan, rendered, template)
      corrected += report.applied
      untouched += report.skipped
      rendered++
      options.onRenderProgress?.(rendered, info.frameCount)
      yield frame
    }
  }

  const encoded = await encodeFrames(corrections(), info, output, {
    ...options,
    audioFrom: options.audioFrom ?? input,
  })

  return {
    info,
    plan,
    framesWritten: encoded.framesWritten,
    framesCorrected: corrected,
    framesLeftUntouched: untouched,
    audioCopied: encoded.audioCopied,
  }
}
