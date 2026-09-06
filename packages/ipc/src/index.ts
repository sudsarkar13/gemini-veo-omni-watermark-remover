/**
 * The contract between the Electron main process and the renderer.
 *
 * Shared by both sides so the two cannot drift: the preload bridge, the main-process
 * handlers, and the React code all typecheck against these declarations.
 *
 * Nothing here carries frame data or file contents. The renderer receives paths,
 * metadata and progress — never pixels — which keeps a large clip from being copied
 * across the IPC boundary and keeps the structured-clone cost negligible.
 */

export type JobState =
  | "queued"
  | "analysing"
  | "ready"
  | "processing"
  | "done"
  /** Succeeded, but some frames were deliberately left untouched. Not a silent pass. */
  | "done-with-skips"
  /** Completed with no watermark found. Informational, not an error. */
  | "no-mark-found"
  | "failed"
  | "cancelled"

export interface ClipInfo {
  readonly width: number
  readonly height: number
  readonly frameRate: number
  readonly durationSeconds: number
  readonly frameCount: number
  readonly videoCodec: string
  readonly hasAudio: boolean
  readonly audioCodec: string | null
  readonly bitRate: number | null
  readonly sizeBytes: number
  /** False for resolutions nobody has measured. Surfaced in the UI, never hidden. */
  readonly calibratedResolution: boolean
}

/**
 * Pre-flight prediction shown before a run.
 *
 * Presented as an estimate and never as a promise — the UI wording must match. Its
 * purpose is to let someone close other applications or pick a different drive
 * before committing, not to be accurate to the second.
 */
export interface ResourceEstimate {
  readonly seconds: number
  readonly peakMemoryBytes: number
  readonly tempDiskBytes: number
  readonly cores: number
  /** Above a threshold the UI escalates from a quiet line to an amber card. */
  readonly heavy: boolean
  /** True when the estimate exceeds what the machine physically has. */
  readonly exceedsResources: boolean
}

export interface JobProgress {
  readonly stage: "analysing" | "rendering"
  readonly frame: number
  readonly totalFrames: number
  readonly fraction: number
  readonly framesPerSecond: number
  readonly etaSeconds: number | null
}

export interface JobResult {
  readonly outputPath: string
  readonly tracksFound: number
  readonly tracksRejected: number
  readonly framesCorrected: number
  /** Frames a track covered but deliberately declined to correct, e.g. occlusion. */
  readonly framesLeftUntouched: number
  /**
   * Frames inside the tracked span that no track reached, so nothing was applied and
   * the mark is still on them. The one number that means the output is not clean.
   */
  readonly framesUncovered: number
  /** Where those frames are, so the timeline can show them rather than total them. */
  readonly uncoveredRanges: readonly { readonly from: number; readonly to: number }[]
  /** First and last frame any track covered, or -1 when nothing was tracked. */
  readonly trackedFrom: number
  readonly trackedTo: number
  readonly audioCopied: boolean
  readonly elapsedMs: number
}

/**
 * Everything the renderer needs to show a clip: playable URLs plus the filmstrip and
 * waveform that make the timeline navigable.
 *
 * URLs, not pixels. The renderer is Chromium and decodes the file itself, so no frame
 * data crosses IPC.
 */
export interface ClipMedia {
  readonly sourceUrl: string
  /** Null until the job has produced a result. */
  readonly outputUrl: string | null
  readonly thumbnails: readonly string[]
  /** Seconds of video each thumbnail represents. */
  readonly thumbnailInterval: number
  /** Peak-amplitude envelope in 0..1, or null when the clip has no audio. */
  readonly waveform: readonly number[] | null
  readonly aspectRatio: number
}

/**
 * A denser filmstrip over part of the clip, fetched when the timeline zooms in.
 *
 * The clip-wide strip in `ClipMedia` is fixed at a couple of dozen pictures. Zoomed to
 * a second of video that strip has nothing left to show, so the timeline asks for the
 * window it is actually displaying and the main process samples it directly.
 */
export interface FilmstripWindow {
  readonly thumbnails: readonly string[]
  /** The window actually sampled, which may be clamped to the clip. */
  readonly fromSeconds: number
  readonly toSeconds: number
  /** Seconds of video each thumbnail represents. */
  readonly interval: number
}

export interface Job {
  readonly id: string
  readonly inputPath: string
  readonly fileName: string
  readonly state: JobState
  readonly progress: JobProgress | null
  readonly info: ClipInfo | null
  readonly estimate: ResourceEstimate | null
  readonly result: JobResult | null
  /** Plain-language cause, with the demuxer's own message preserved verbatim. */
  readonly error: string | null
  readonly addedAt: number
}

export interface JobOptions {
  readonly mode?: "auto" | "corner" | "sweep"
  readonly sweepInterval?: number
  readonly crf?: number
  readonly preset?: string
  readonly encoder?: "auto" | "software" | "hardware"
  readonly templatePath?: string
  readonly outputDirectory?: string
  readonly region?: { x: number; y: number; width: number; height: number }
  readonly gain?: number
  /**
   * Regions the user drew over marks the detector did not find, each with the frames
   * it applies to. A prior for the search, never a licence to subtract: the engine
   * still measures the alpha by reversibility before removing anything.
   */
  readonly manualMarks?: readonly ManualMarkInput[]
}

export interface ManualMarkInput {
  readonly id: string
  readonly rect: { x: number; y: number; width: number; height: number }
  /** Inclusive, in frames. */
  readonly fromFrame: number
  readonly toFrame: number
}

export interface SystemInfo {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly cores: number
  readonly totalMemoryBytes: number
  readonly freeMemoryBytes: number
  readonly appVersion: string
  readonly ffmpegAvailable: boolean
  /** Present when FFmpeg is missing: a packaging fault, phrased as one. */
  readonly ffmpegError: string | null
}

export interface Settings {
  readonly theme: "system" | "dark" | "light"
  readonly maxConcurrentJobs: number
  readonly outputDirectory: string | null
  readonly encoder: "auto" | "software" | "hardware"
  readonly crf: number
  /** Diagnostics are opt-in and stay off until explicitly enabled. */
  readonly diagnosticsEnabled: boolean
  readonly feedbackPromptEnabled: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  // One at a time by default: processing is already parallel across cores
  // internally, so running several clips mostly causes memory pressure and makes
  // every job slower.
  maxConcurrentJobs: 1,
  outputDirectory: null,
  encoder: "auto",
  crf: 14,
  diagnosticsEnabled: false,
  feedbackPromptEnabled: true,
}

/** Channels the renderer may invoke. Anything not listed here is not reachable. */
export const CHANNELS = {
  jobsAdd: "jobs:add",
  jobsAddPaths: "jobs:add-paths",
  jobsList: "jobs:list",
  jobsRemove: "jobs:remove",
  jobsClearFinished: "jobs:clear-finished",
  jobsStart: "jobs:start",
  jobsCancel: "jobs:cancel",
  jobsReveal: "jobs:reveal",
  jobsMedia: "jobs:media",
  jobsFilmstrip: "jobs:filmstrip",
  systemInfo: "system:info",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  windowMinimise: "window:minimise",
  windowMaximise: "window:maximise",
  windowClose: "window:close",
} as const

/** Events pushed from main to the renderer. */
export const EVENTS = {
  jobsChanged: "jobs:changed",
  jobProgress: "job:progress",
} as const

/** The surface exposed on `window.gvowr` by the preload bridge. */
export interface DesktopApi {
  addFiles(): Promise<Job[]>
  addPaths(paths: readonly string[]): Promise<Job[]>
  listJobs(): Promise<Job[]>
  removeJob(id: string): Promise<void>
  clearFinished(): Promise<void>
  startJob(id: string, options?: JobOptions): Promise<void>
  cancelJob(id: string): Promise<void>
  revealOutput(id: string): Promise<void>
  getMedia(id: string): Promise<ClipMedia | null>
  /** Thumbnails for one window of the clip. Null when the clip cannot be sampled. */
  getFilmstrip(
    id: string,
    fromSeconds: number,
    toSeconds: number,
    count: number
  ): Promise<FilmstripWindow | null>
  systemInfo(): Promise<SystemInfo>
  getSettings(): Promise<Settings>
  setSettings(partial: Partial<Settings>): Promise<Settings>
  minimiseWindow(): void
  maximiseWindow(): void
  closeWindow(): void
  onJobsChanged(listener: (jobs: Job[]) => void): () => void
  onJobProgress(listener: (id: string, progress: JobProgress) => void): () => void
}

export const ACCEPTED_EXTENSIONS = ["mp4", "mov", "mkv", "webm"] as const
