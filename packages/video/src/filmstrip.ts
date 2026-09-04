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
  /** How many thumbnails to produce across the whole clip. */
  readonly count?: number
  /** Thumbnail width in pixels; height follows the source aspect ratio. */
  readonly width?: number
}

export interface Filmstrip {
  readonly directory: string
  /** Absolute paths, in order. */
  readonly frames: string[]
  /** Seconds of source video each thumbnail represents. */
  readonly interval: number
  readonly width: number
  readonly height: number
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

  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true })

  const duration = meta.durationSeconds > 0 ? meta.durationSeconds : count / meta.frameRate
  const interval = duration / count
  const { ffmpeg } = await resolveBinaries()

  // fps=1/interval samples evenly across the clip. -vsync vfr stops FFmpeg padding
  // duplicates when the requested rate does not divide the source rate evenly.
  await run(ffmpeg, [
    "-v", "error",
    "-nostdin",
    "-i", input,
    "-vf", `fps=${1 / interval},scale=${width}:${height}`,
    "-vsync", "vfr",
    "-frames:v", String(count),
    "-q:v", "4",
    join(outputDirectory, "thumb_%04d.jpg"),
  ])

  const names = (await readdir(outputDirectory)).filter((n) => n.endsWith(".jpg")).sort()
  return {
    directory: outputDirectory,
    frames: names.map((name) => join(outputDirectory, name)),
    interval,
    width,
    height,
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
