import { readFile } from "node:fs/promises"

import { defaultTemplate, loadTemplatePpm, type AlphaMap } from "@gvowr/engine"
import { processImage, processVideo } from "@gvowr/video"

import type { JobOptions, MediaKind } from "@gvowr/ipc"

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

export interface StartMessage {
  readonly type: "start"
  readonly kind: MediaKind
  readonly input: string
  readonly output: string
  readonly options: JobOptions
}

export type WorkerMessage =
  | { type: "progress"; stage: "analysing" | "rendering"; frame: number; totalFrames: number }
  | { type: "done"; result: WorkerResult }
  | { type: "failed"; message: string }

export interface WorkerResult {
  /** False when nothing was written and the original was left untouched. */
  readonly written: boolean
  readonly reason: "no-mark-found" | "not-invertible" | null
  readonly tracksFound: number
  readonly tracksRejected: number
  readonly framesCorrected: number
  readonly framesLeftUntouched: number
  readonly framesUncovered: number
  readonly uncoveredRanges: readonly { readonly from: number; readonly to: number }[]
  readonly trackedFrom: number
  readonly trackedTo: number
  readonly audioCopied: boolean
  readonly elapsedMs: number
}

async function loadTemplate(options: JobOptions): Promise<AlphaMap> {
  if (options.templatePath) return loadTemplatePpm(await readFile(options.templatePath))
  return defaultTemplate()
}

/**
 * The renderer's id is for the interface's benefit; the engine takes the geometry and
 * the range and nothing else.
 */
function manualMarksFor(options: JobOptions): {
  manualMarks?: { rect: { x: number; y: number; width: number; height: number }; fromFrame: number; toFrame: number }[]
} {
  if (!options.manualMarks?.length) return {}
  return {
    manualMarks: options.manualMarks.map((mark) => ({
      rect: mark.rect,
      fromFrame: mark.fromFrame,
      toFrame: mark.toFrame,
    })),
  }
}

function send(message: WorkerMessage): void {
  process.send?.(message)
}

process.on("message", (message: StartMessage) => {
  if (message.type !== "start") return

  void (async () => {
    const started = Date.now()
    try {
      const template = await loadTemplate(message.options)

      if (message.kind === "image") {
        const image = await processImage(message.input, message.output, template, {
          ...(message.options.mode ? { mode: message.options.mode } : {}),
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
            // A still has no timeline, so it has no gaps in one. Saying "0 frames
            // uncovered" here is a fact, not a reassurance: `written` is what carries
            // the bad news.
            framesUncovered: 0,
            uncoveredRanges: [],
            trackedFrom: image.applied > 0 ? 0 : -1,
            trackedTo: image.applied > 0 ? 0 : -1,
            audioCopied: false,
            elapsedMs: Date.now() - started,
          },
        })
        return
      }

      const result = await processVideo(message.input, message.output, template, {
        ...(message.options.mode ? { mode: message.options.mode } : {}),
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
          framesUncovered: result.coverage.framesUncovered,
          uncoveredRanges: result.coverage.gaps,
          trackedFrom: result.coverage.firstFrame,
          trackedTo: result.coverage.lastFrame,
          audioCopied: result.audioCopied,
          elapsedMs: Date.now() - started,
        },
      })
    } catch (error) {
      send({ type: "failed", message: error instanceof Error ? error.message : String(error) })
    } finally {
      process.exit(0)
    }
  })()
})
