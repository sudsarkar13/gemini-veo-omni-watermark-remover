import { mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"

import { resolveBinaries, run } from "./ffmpeg.ts"
import { probe, type VideoInfo } from "./probe.ts"

/**
 * Filmstrip extraction: a row of small thumbnails spanning the clip.
 *
 * One FFmpeg invocation writes every thumbnail, rather than seeking once per frame.
 * Seeking repeatedly into a long-GOP h264 stream is dramatically slower — each seek
 * decodes from the preceding keyframe — so a single linear pass wins by a wide margin
 * even though it touches more data.
 */

export interface FilmstripOptions {
  /** How many thumbnails to produce across the window. */
  readonly count?: number
  /** Thumbnail width in pixels; height follows the source aspect ratio. */
  readonly width?: number
  /**
   * Window into the clip, in seconds. Defaults to the whole thing.
   *
   * A zoomed timeline covers a second or two of video, and stretching the clip-wide
   * strip across it shows the same twenty-eight pictures ten times larger — which
   * tells the user nothing they could not already see. Sampling the window itself is
   * what makes zooming worth doing.
   */
  readonly startSeconds?: number
  readonly durationSeconds?: number
  /** Filename prefix, so several windows can live in one directory. */
  readonly prefix?: string
  /** Whether to empty the directory first. Off when adding a window to an existing strip. */
  readonly replace?: boolean
}

export interface Filmstrip {
  readonly directory: string
  /** Absolute paths, in order. */
  readonly frames: string[]
  /** Seconds of source video each thumbnail represents. */
  readonly interval: number
  readonly width: number
  readonly height: number
  /** The window actually sampled, which may be shorter than the one asked for. */
  readonly startSeconds: number
  readonly durationSeconds: number
}

/**
 * The window actually sampled, given the one asked for.
 *
 * Separated out and exported because this is where a zoomed timeline can go wrong in
 * ways nothing downstream would notice: a window past the end of the clip, or one
 * shorter than a single frame, would otherwise reach FFmpeg as a zero or negative
 * duration and come back as an empty strip — or as a division by zero in the fps
 * filter. Both clamp to the last frame instead.
 */
export function resolveWindow(
  clipDuration: number,
  frameRate: number,
  options: Pick<FilmstripOptions, "startSeconds" | "durationSeconds">
): { start: number; duration: number } {
  const frame = 1 / (frameRate > 0 ? frameRate : 30)
  const start = Math.max(0, Math.min(options.startSeconds ?? 0, Math.max(0, clipDuration - frame)))
  const duration = Math.max(
    frame,
    Math.min(options.durationSeconds ?? clipDuration - start, clipDuration - start)
  )
  return { start, duration }
}

export async function extractFilmstrip(
  input: string,
  outputDirectory: string,
  info?: VideoInfo,
  options: FilmstripOptions = {}
): Promise<Filmstrip> {
  const meta = info ?? (await probe(input))
  const count = Math.max(4, Math.min(options.count ?? 40, 200))
  const width = options.width ?? 160
  const height = Math.max(2, Math.round((width * meta.height) / meta.width))
  const prefix = options.prefix ?? "thumb"

  if (options.replace ?? true) {
    await rm(outputDirectory, { recursive: true, force: true })
  }
  await mkdir(outputDirectory, { recursive: true })

  const clipDuration = meta.durationSeconds > 0 ? meta.durationSeconds : count / meta.frameRate
  const { start, duration } = resolveWindow(clipDuration, meta.frameRate, options)
  const interval = duration / count
  const { ffmpeg } = await resolveBinaries()

  // -ss before -i seeks by keyframe index rather than decoding up to the point, which
  // is the difference between a window opening instantly and a long clip stalling the
  // timeline every time it is zoomed.
  //
  // fps=1/interval samples evenly across the window. -vsync vfr stops FFmpeg padding
  // duplicates when the requested rate does not divide the source rate evenly.
  await run(ffmpeg, [
    "-v", "error",
    "-nostdin",
    ...(start > 0 ? ["-ss", start.toFixed(3)] : []),
    "-i", input,
    "-t", duration.toFixed(3),
    "-vf", `fps=${1 / interval},scale=${width}:${height}`,
    "-vsync", "vfr",
    "-frames:v", String(count),
    "-q:v", "4",
    join(outputDirectory, `${prefix}_%04d.jpg`),
  ])

  const names = (await readdir(outputDirectory))
    .filter((name) => name.startsWith(`${prefix}_`) && name.endsWith(".jpg"))
    .sort()
  return {
    directory: outputDirectory,
    frames: names.map((name) => join(outputDirectory, name)),
    interval,
    width,
    height,
    startSeconds: start,
    durationSeconds: duration,
  }
}

/**
 * Peak-amplitude envelope of the audio track, for drawing a waveform.
 *
 * Audio is stream-copied untouched by the processing pipeline; this exists purely so
 * the timeline shows where speech and silence fall, which makes scrubbing to a
 * particular moment far easier than guessing from thumbnails alone.
 */
export async function extractWaveform(input: string, buckets = 400): Promise<number[] | null> {
  const meta = await probe(input)
  if (!meta.hasAudio || meta.durationSeconds <= 0) return null

  const { ffmpeg } = await resolveBinaries()
  const rate = Math.max(1, Math.round(buckets / meta.durationSeconds))

  // Mono, 8-bit unsigned, resampled to roughly one sample per bucket. Small enough to
  // cross IPC as plain numbers without a second thought.
  const child = await run(ffmpeg, [
    "-v", "error",
    "-nostdin",
    "-i", input,
    "-map", "0:a:0",
    "-ac", "1",
    "-filter:a", `aresample=${rate}`,
    "-f", "u8",
    "-",
  ]).catch(() => null)

  if (!child) return null

  const samples = Buffer.from(child.stdout, "binary")
  if (samples.length === 0) return null

  const step = Math.max(1, Math.floor(samples.length / buckets))
  const envelope: number[] = []
  for (let i = 0; i + step <= samples.length; i += step) {
    let peak = 0
    for (let j = 0; j < step; j++) {
      // Unsigned 8-bit audio is centred on 128.
      peak = Math.max(peak, Math.abs((samples[i + j] as number) - 128))
    }
    envelope.push(Math.min(1, peak / 128))
  }
  return envelope
}
