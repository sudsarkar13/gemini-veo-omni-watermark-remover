import { readFile } from "node:fs/promises"

import { defaultTemplate, loadTemplatePpm, type AlphaMap } from "@gvowr/engine"
import { processVideo } from "@gvowr/video"

import type { JobOptions } from "@gvowr/ipc"

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
  readonly input: string
  readonly output: string
  readonly options: JobOptions
}

export type WorkerMessage =
  | { type: "progress"; stage: "analysing" | "rendering"; frame: number; totalFrames: number }
  | { type: "done"; result: WorkerResult }
  | { type: "failed"; message: string }

export interface WorkerResult {
  readonly tracksFound: number
  readonly tracksRejected: number
  readonly framesCorrected: number
  readonly framesLeftUntouched: number
  readonly audioCopied: boolean
  readonly elapsedMs: number
}

async function loadTemplate(options: JobOptions): Promise<AlphaMap> {
  if (options.templatePath) return loadTemplatePpm(await readFile(options.templatePath))
  return defaultTemplate()
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
      const result = await processVideo(message.input, message.output, template, {
        ...(message.options.mode ? { mode: message.options.mode } : {}),
        ...(message.options.sweepInterval ? { sweepInterval: message.options.sweepInterval } : {}),
        ...(message.options.crf !== undefined ? { crf: message.options.crf } : {}),
        ...(message.options.preset ? { preset: message.options.preset } : {}),
        ...(message.options.encoder ? { encoder: message.options.encoder } : {}),
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
          tracksFound: result.plan.tracks.length,
          tracksRejected: result.plan.diagnostics.tracksRejected,
          framesCorrected: result.framesCorrected,
          framesLeftUntouched: result.framesLeftUntouched,
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
