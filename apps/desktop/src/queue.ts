import { fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"

import { hasCalibratedProfile } from "@gvowr/engine"
import { probe } from "@gvowr/video"

import { estimate } from "./estimate.ts"
import { registerMedia, setMediaOutput, unregisterMedia } from "./media.ts"
import type { ClipInfo, Job, JobOptions, JobProgress, JobState } from "@gvowr/ipc"
import type { StartMessage, WorkerMessage } from "./worker.ts"

/**
 * The job queue.
 *
 * Owns all job state in the main process and pushes snapshots to the renderer. The
 * renderer never mutates a job directly — it asks, and re-renders from whatever comes
 * back — so there is one source of truth and no reconciliation to get wrong.
 */

export interface QueueEvents {
  onChanged(jobs: Job[]): void
  onProgress(id: string, progress: JobProgress): void
}

interface Running {
  readonly child: ChildProcess
  readonly startedAt: number
  lastFrame: number
  lastSampleAt: number
  framesPerSecond: number
}

export class JobQueue {
  readonly #jobs = new Map<string, Job>()
  readonly #running = new Map<string, Running>()
  readonly #events: QueueEvents
  readonly #workerPath: string
  #maxConcurrent = 1

  constructor(events: QueueEvents, workerPath: string) {
    this.#events = events
    this.#workerPath = workerPath
  }

  setConcurrency(value: number): void {
    this.#maxConcurrent = Math.max(1, Math.floor(value))
  }

  list(): Job[] {
    return [...this.#jobs.values()].sort((a, b) => a.addedAt - b.addedAt)
  }

  /**
   * Adds files and probes each one.
   *
   * Probing here rather than at run time means the queue can show resolution,
   * duration and a resource estimate immediately, and an undecodable file fails
   * straight away with the demuxer's own message instead of after a long wait.
   */
  async add(paths: readonly string[]): Promise<Job[]> {
    const added: Job[] = []

    for (const path of paths) {
      const id = randomUUID()
      const job: Job = {
        id,
        inputPath: path,
        fileName: basename(path),
        state: "queued",
        progress: null,
        info: null,
        estimate: null,
        result: null,
        error: null,
        addedAt: Date.now(),
      }
      this.#jobs.set(id, job)
      // Registering here is what makes the clip playable: the media protocol serves
      // only files that belong to a job, never an arbitrary path.
      registerMedia(id, path)
      added.push(job)
    }
    this.#emit()

    for (const job of added) {
      try {
        const info = await this.#describe(job.inputPath)
        this.#update(job.id, {
          info,
          estimate: estimate(info, this.#maxConcurrent),
          state: "ready",
        })
      } catch (error) {
        this.#update(job.id, {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return this.list().filter((job) => added.some((a) => a.id === job.id))
  }

  async #describe(path: string): Promise<ClipInfo> {
    const [info, stats] = await Promise.all([probe(path), stat(path)])
    return {
      width: info.width,
      height: info.height,
      frameRate: info.frameRate,
      durationSeconds: info.durationSeconds,
      frameCount: info.frameCount,
      videoCodec: info.videoCodec,
      hasAudio: info.hasAudio,
      audioCodec: info.audioCodec,
      bitRate: info.bitRate,
      sizeBytes: stats.size,
      calibratedResolution: hasCalibratedProfile(info.width, info.height),
    }
  }

  remove(id: string): void {
    this.cancel(id)
    unregisterMedia(id)
    this.#jobs.delete(id)
    this.#emit()
  }

  clearFinished(): void {
    for (const [id, job] of this.#jobs) {
      if (!isFinished(job.state)) continue
      unregisterMedia(id)
      this.#jobs.delete(id)
    }
    this.#emit()
  }

  start(id: string, options: JobOptions = {}): void {
    const job = this.#jobs.get(id)
    if (!job || this.#running.has(id)) return
    if (job.state === "processing" || job.state === "analysing") return
    if (!job.info) {
      this.#update(id, { state: "failed", error: "clip was never successfully probed" })
      return
    }
    if (this.#running.size >= this.#maxConcurrent) return

    const output = outputPathFor(job.inputPath, options.outputDirectory ?? null)
    const child = fork(this.#workerPath, [], {
      // Silencing stdio keeps a chatty child from flooding the main process; failures
      // still arrive as structured messages.
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    })

    const running: Running = {
      child,
      startedAt: Date.now(),
      lastFrame: 0,
      lastSampleAt: Date.now(),
      framesPerSecond: 0,
    }
    this.#running.set(id, running)
    this.#update(id, { state: "analysing", progress: null, error: null, result: null })

    let stderr = ""
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })

    child.on("message", (message: WorkerMessage) => {
      this.#handleWorkerMessage(id, output, running, message)
    })

    child.on("error", (error) => {
      this.#running.delete(id)
      this.#update(id, { state: "failed", error: error.message })
    })

    child.on("exit", (code, signal) => {
      if (!this.#running.has(id)) return
      this.#running.delete(id)
      const current = this.#jobs.get(id)
      // A worker that dies without reporting is a crash, not a success. Say so, and
      // include whatever it managed to write to stderr.
      if (current && !isFinished(current.state)) {
        this.#update(id, {
          state: signal === "SIGTERM" ? "cancelled" : "failed",
          error:
            signal === "SIGTERM"
              ? null
              : `processing stopped unexpectedly (code ${code ?? "none"})${stderr ? `\n${stderr.trim()}` : ""}`,
        })
      }
    })

    const message: StartMessage = { type: "start", input: job.inputPath, output, options }
    child.send(message)
  }

  #handleWorkerMessage(id: string, output: string, running: Running, message: WorkerMessage): void {
    if (message.type === "progress") {
      const now = Date.now()
      const elapsed = (now - running.lastSampleAt) / 1000
      if (elapsed > 0.25) {
        const frames = message.frame - running.lastFrame
        // Smoothed, because a raw instantaneous rate jitters too much to read.
        running.framesPerSecond =
          running.framesPerSecond === 0
            ? frames / elapsed
            : running.framesPerSecond * 0.7 + (frames / elapsed) * 0.3
        running.lastFrame = message.frame
        running.lastSampleAt = now
      }

      // Two passes over the clip, so each contributes half of the reported progress.
      const stageFraction = message.totalFrames > 0 ? message.frame / message.totalFrames : 0
      const fraction = message.stage === "analysing" ? stageFraction * 0.5 : 0.5 + stageFraction * 0.5
      const remaining = message.totalFrames * (message.stage === "analysing" ? 2 : 1) - message.frame

      const progress: JobProgress = {
        stage: message.stage,
        frame: message.frame,
        totalFrames: message.totalFrames,
        fraction: Math.min(1, Math.max(0, fraction)),
        framesPerSecond: running.framesPerSecond,
        etaSeconds:
          running.framesPerSecond > 0 ? Math.max(0, remaining / running.framesPerSecond) : null,
      }

      this.#update(id, { state: message.stage === "analysing" ? "analysing" : "processing", progress })
      this.#events.onProgress(id, progress)
      return
    }

    if (message.type === "done") {
      const { result } = message
      // Three distinct successful outcomes, kept distinct. Reporting a clip with
      // skipped frames as plainly "done" would hide exactly what the user needs to
      // check, and finding no mark is information, not failure.
      //
      // Frames no track reached count here too. They are the more serious of the two
      // — a deliberate skip is a decision we can explain, an uncovered frame is one
      // we lost — and calling a clip that still carries the mark "done" is the exact
      // dishonesty this state exists to prevent.
      const incomplete = result.framesLeftUntouched > 0 || result.framesUncovered > 0
      const state: JobState =
        result.tracksFound === 0 ? "no-mark-found" : incomplete ? "done-with-skips" : "done"

      setMediaOutput(id, output)
      this.#update(id, { state, progress: null, result: { ...result, outputPath: output } })
      return
    }

    this.#update(id, { state: "failed", error: message.message, progress: null })
  }

  cancel(id: string): void {
    const running = this.#running.get(id)
    if (!running) return
    this.#running.delete(id)
    running.child.kill("SIGTERM")
    this.#update(id, { state: "cancelled", progress: null })
  }

  cancelAll(): void {
    for (const id of [...this.#running.keys()]) this.cancel(id)
  }

  #update(id: string, patch: Partial<Job>): void {
    const job = this.#jobs.get(id)
    if (!job) return
    this.#jobs.set(id, { ...job, ...patch })
    this.#emit()
  }

  #emit(): void {
    this.#events.onChanged(this.list())
  }
}

export function isFinished(state: JobState): boolean {
  return (
    state === "done" ||
    state === "done-with-skips" ||
    state === "no-mark-found" ||
    state === "failed" ||
    state === "cancelled"
  )
}

/** `clip.mp4` becomes `clip_clean.mp4`, beside the source unless told otherwise. */
export function outputPathFor(input: string, outputDirectory: string | null): string {
  const extension = extname(input) || ".mp4"
  const stem = basename(input, extension)
  return join(outputDirectory ?? dirname(input), `${stem}_clean${extension}`)
}
