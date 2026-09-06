import {
  coverage,
  createPlanner,
  createResidualChecker,
  renderFrame,
  type AlphaMap,
  type ClipPlan,
  type Coverage,
  type Frame,
  type PlanOptions,
  type RenderOptions,
  type ResidualOptions,
  type ResidualReport,
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

export interface ProcessOptions extends PlanOptions, EncodeOptions, RenderOptions {
  readonly onAnalyseProgress?: (frame: number, total: number) => void
  readonly onRenderProgress?: (frame: number, total: number) => void
  /** Pass 4, the residual check. On unless switched off. */
  readonly check?: boolean
  readonly checkOptions?: ResidualOptions
  readonly onCheckProgress?: (frame: number, total: number) => void
}

export interface ProcessResult {
  readonly info: VideoInfo
  readonly plan: ClipPlan
  readonly framesWritten: number
  readonly framesCorrected: number
  /** Frames a track covered but deliberately declined to correct, e.g. occlusion. */
  readonly framesLeftUntouched: number
  /** Frames where pixels were synthesised rather than recovered. Never folded in. */
  readonly framesFilled: number
  /**
   * Frames inside the tracked span that no track reached at all.
   *
   * Distinct from `framesLeftUntouched`, which is a decision. These are frames the
   * mark was almost certainly on and the plan lost, so they leave the tool with
   * nothing to say — which is exactly why they have to be said out loud.
   */
  readonly coverage: Coverage
  readonly audioCopied: boolean
  /** What the finished file still shows. Null when the check was switched off. */
  readonly residual: ResidualReport | null
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
  let filled = 0
  let rendered = 0

  async function* corrections(): AsyncGenerator<Frame, void, undefined> {
    for await (const frame of decodeFrames(input, info)) {
      const report = renderFrame(frame, plan, rendered, template, {
        ...(options.fill !== undefined ? { fill: options.fill } : {}),
        ...(options.fillOptions ? { fillOptions: options.fillOptions } : {}),
      })
      corrected += report.applied
      untouched += report.skipped
      filled += report.filled
      rendered++
      options.onRenderProgress?.(rendered, info.frameCount)
      yield frame
    }
  }

  const encoded = await encodeFrames(corrections(), info, output, {
    ...options,
    audioFrom: options.audioFrom ?? input,
  })

  // Pass 4: check the render. Deliberately the encoded file rather than the frames we
  // just handed the encoder — compression is part of what the user will see, and a
  // correction that survives renderFrame but not CRF 14 is still a correction that
  // did not survive.
  const residual = options.check === false ? null : await check()

  async function check(): Promise<ResidualReport> {
    const outputInfo = await probe(output)
    const checker = createResidualChecker(template, {
      tracks: plan.tracks,
      ...(options.checkOptions ?? {}),
    })
    let checked = 0
    for await (const frame of decodeFrames(output, outputInfo)) {
      checker.push(frame)
      checked++
      options.onCheckProgress?.(checked, outputInfo.frameCount)
    }
    return checker.finish()
  }

  return {
    info,
    plan,
    residual,
    framesWritten: encoded.framesWritten,
    framesCorrected: corrected,
    framesLeftUntouched: untouched,
    framesFilled: filled,
    coverage: coverage(plan.tracks),
    audioCopied: encoded.audioCopied,
  }
}
