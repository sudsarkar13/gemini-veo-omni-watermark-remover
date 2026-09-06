import { readFile } from "node:fs/promises"

import { createResidualChecker, defaultTemplate, loadTemplatePpm, type AlphaMap } from "@gvowr/engine"
import {
  decodeFrames,
  decodeImage,
  probe,
  probeImage,
  processImage,
  processVideo,
} from "@gvowr/video"

import type {
  JobOptions,
  ManualOutcomeSummary,
  MediaKind,
  ResidualSummary,
} from "@gvowr/ipc"

/**
 * Child process that runs one job.
 *
 * Removal is CPU-bound for minutes at a time. Running it in the main process would
 * stall IPC and freeze the window, and running it in the renderer would do the same
 * to the UI thread — so each job gets its own process, which also means a crash or a
 * cancel kills exactly one job and nothing else.
 *
 * Communication is plain structured-clone messages. No frame data crosses the
 * boundary; only counters and progress.
 */

/**
 * Re-runs the check against a file that has already been rendered.
 *
 * Standalone, and out of process for the same reason a job is: a decode plus a sweep
 * over a long clip would hold the main process for as long as it takes, and the
 * window would sit there not repainting.
 *
 * It carries no plan, so it can only ask the second of the check's two questions —
 * was a mark missed. Under-shoot is found by re-scoring the rectangles the plan
 * touched, and those are not kept once a run is over.
 */
export interface CheckMessage {
  readonly type: "check"
  readonly kind: MediaKind
  readonly path: string
  readonly templatePath?: string
}

export interface StartMessage {
  readonly type: "start"
  readonly kind: MediaKind
  readonly input: string
  readonly output: string
  readonly options: JobOptions
}

export type WorkerMessage =
  | {
      type: "progress"
      stage: "analysing" | "rendering" | "checking"
      frame: number
      totalFrames: number
    }
  | { type: "done"; result: WorkerResult }
  | { type: "checked"; residual: ResidualSummary | null }
  | { type: "failed"; message: string }

export interface WorkerResult {
  readonly manualOutcomes: readonly ManualOutcomeSummary[]
  /** False when nothing was written and the original was left untouched. */
  readonly written: boolean
  readonly reason: "no-mark-found" | "not-invertible" | null
  readonly tracksFound: number
  readonly tracksRejected: number
  readonly framesCorrected: number
  readonly framesLeftUntouched: number
  readonly framesFilled: number
  readonly framesUncovered: number
  readonly uncoveredRanges: readonly { readonly from: number; readonly to: number }[]
  readonly trackedFrom: number
  readonly trackedTo: number
  readonly audioCopied: boolean
  readonly elapsedMs: number
  /** What the finished file still shows, or null when nothing was written to check. */
  readonly residual: ResidualSummary | null
}

/**
 * The engine's residual report, flattened for IPC.
 *
 * Rebuilt field by field rather than passed through, because structured clone will
 * happily carry engine internals across the process boundary and then the renderer
 * starts depending on them.
 */
function summariseResidual(
  report: {
    framesChecked: number
    framesMarked: number
    sweepInterval: number
    ranges: readonly {
      from: number
      to: number
      rect: { x: number; y: number; width: number; height: number }
      kind: "missed" | "under-corrected"
      peakScore: number
      peakAlpha: number
    }[]
  } | null
): ResidualSummary | null {
  if (!report) return null
  return {
    framesChecked: report.framesChecked,
    framesMarked: report.framesMarked,
    sweepInterval: report.sweepInterval,
    checkedAt: Date.now(),
    ranges: report.ranges.map((range) => ({
      from: range.from,
      to: range.to,
      rect: range.rect,
      kind: range.kind,
      peakScore: range.peakScore,
      peakAlpha: range.peakAlpha,
    })),
  }
}

async function loadTemplate(options: JobOptions): Promise<AlphaMap> {
  if (options.templatePath) return loadTemplatePpm(await readFile(options.templatePath))
  return defaultTemplate()
}

function manualMarksFor(options: JobOptions): {
  manualMarks?: {
    id: string
    rect: { x: number; y: number; width: number; height: number }
    fromFrame: number
    toFrame: number
  }[]
} {
  if (!options.manualMarks?.length) return {}
  return {
    manualMarks: options.manualMarks.map((mark) => ({
      // The id is the renderer's, carried through untouched so the result can be
      // reported against the region the user drew rather than matched back by
      // geometry — which stops agreeing as soon as the search settles a few pixels
      // away from the box.
      id: mark.id,
      rect: mark.rect,
      fromFrame: mark.fromFrame,
      toFrame: mark.toFrame,
    })),
  }
}

/**
 * The engine's per-region outcomes, plus how many of them were filled.
 *
 * The engine reports what verified and what it refused; whether a refusal was then
 * synthesised is a rendering decision, so the two are joined here rather than either
 * side pretending to know the other's business.
 */
function outcomesFor(
  plan: { manualOutcomes: readonly { markId: string; removed: number; refused: number; alpha: number | null; confidence: number | null }[]; refusals: readonly { markId?: string }[] },
  filled: boolean
): ManualOutcomeSummary[] {
  return plan.manualOutcomes.map((outcome) => ({
    markId: outcome.markId,
    removed: outcome.removed,
    refused: outcome.refused,
    filled: filled ? outcome.refused : 0,
    alpha: outcome.alpha,
    confidence: outcome.confidence,
  }))
}

function send(message: WorkerMessage): void {
  process.send?.(message)
}

/** A check on its own, over a file that has already been written. */
async function runCheck(message: CheckMessage): Promise<ResidualSummary | null> {
  const template = await loadTemplate(
    message.templatePath ? { templatePath: message.templatePath } : {}
  )
  const checker = createResidualChecker(template)

  if (message.kind === "image") {
    checker.push(await decodeImage(message.path, await probeImage(message.path)))
  } else {
    const info = await probe(message.path)
    let checked = 0
    for await (const frame of decodeFrames(message.path, info)) {
      checker.push(frame)
      checked++
      send({ type: "progress", stage: "checking", frame: checked, totalFrames: info.frameCount })
    }
  }

  return summariseResidual(checker.finish())
}

process.on("message", (message: StartMessage | CheckMessage) => {
  if (message.type === "check") {
    void (async () => {
      try {
        send({ type: "checked", residual: await runCheck(message) })
      } catch (error) {
        send({ type: "failed", message: error instanceof Error ? error.message : String(error) })
      } finally {
        process.exit(0)
      }
    })()
    return
  }

  if (message.type !== "start") return

  void (async () => {
    const started = Date.now()
    try {
      const template = await loadTemplate(message.options)

      if (message.kind === "image") {
        const image = await processImage(message.input, message.output, template, {
          ...(message.options.mode ? { mode: message.options.mode } : {}),
          ...(message.options.fill ? { fill: true } : {}),
          ...manualMarksFor(message.options),
        })

        send({
          type: "done",
          result: {
            written: image.written,
            reason: image.reason,
            tracksFound: image.plan.tracks.length,
            tracksRejected: image.plan.diagnostics.tracksRejected,
            framesCorrected: image.applied,
            framesLeftUntouched: image.skipped,
            framesFilled: image.filled,
            manualOutcomes: outcomesFor(image.plan, message.options.fill === true),
            // A still has no timeline, so it has no gaps in one. Saying "0 frames
            // uncovered" here is a fact, not a reassurance: `written` is what carries
            // the bad news.
            framesUncovered: 0,
            uncoveredRanges: [],
            trackedFrom: image.applied > 0 ? 0 : -1,
            trackedTo: image.applied > 0 ? 0 : -1,
            audioCopied: false,
            elapsedMs: Date.now() - started,
            residual: summariseResidual(image.residual),
          },
        })
        return
      }

      const result = await processVideo(message.input, message.output, template, {
        ...(message.options.mode ? { mode: message.options.mode } : {}),
        ...(message.options.fill ? { fill: true } : {}),
        ...(message.options.sweepInterval ? { sweepInterval: message.options.sweepInterval } : {}),
        ...(message.options.crf !== undefined ? { crf: message.options.crf } : {}),
        ...(message.options.preset ? { preset: message.options.preset } : {}),
        ...(message.options.encoder ? { encoder: message.options.encoder } : {}),
        ...manualMarksFor(message.options),
        onAnalyseProgress: (frame, totalFrames) => {
          send({ type: "progress", stage: "analysing", frame, totalFrames })
        },
        onRenderProgress: (frame, totalFrames) => {
          send({ type: "progress", stage: "rendering", frame, totalFrames })
        },
        onCheckProgress: (frame, totalFrames) => {
          send({ type: "progress", stage: "checking", frame, totalFrames })
        },
      })

      send({
        type: "done",
        result: {
          written: true,
          reason: null,
          tracksFound: result.plan.tracks.length,
          tracksRejected: result.plan.diagnostics.tracksRejected,
          framesCorrected: result.framesCorrected,
          framesLeftUntouched: result.framesLeftUntouched,
          framesFilled: result.framesFilled,
          manualOutcomes: outcomesFor(result.plan, message.options.fill === true),
          framesUncovered: result.coverage.framesUncovered,
          uncoveredRanges: result.coverage.gaps,
          trackedFrom: result.coverage.firstFrame,
          trackedTo: result.coverage.lastFrame,
          audioCopied: result.audioCopied,
          elapsedMs: Date.now() - started,
          residual: summariseResidual(result.residual),
        },
      })
    } catch (error) {
      send({ type: "failed", message: error instanceof Error ? error.message : String(error) })
    } finally {
      process.exit(0)
    }
  })()
})
