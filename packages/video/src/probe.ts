import { resolveBinaries, run } from "./ffmpeg.ts"

/**
 * Container and stream metadata, read with ffprobe.
 *
 * Only what the pipeline and the UI actually need. Notably this is exactly the
 * information a diagnostic report carries about a clip — resolution, codec, rate,
 * duration — and never its content.
 */

export interface VideoInfo {
  readonly width: number
  readonly height: number
  /** Frames per second as a decimal, derived from the container's rational rate. */
  readonly frameRate: number
  readonly durationSeconds: number
  /** Reported frame count, or an estimate from duration when the container lies. */
  readonly frameCount: number
  readonly videoCodec: string
  readonly pixelFormat: string
  readonly bitRate: number | null
  readonly hasAudio: boolean
  readonly audioCodec: string | null
}

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  pix_fmt?: string
  avg_frame_rate?: string
  r_frame_rate?: string
  nb_frames?: string
  duration?: string
  bit_rate?: string
}

interface ProbeOutput {
  streams?: ProbeStream[]
  format?: { duration?: string; bit_rate?: string }
}

export async function probe(path: string): Promise<VideoInfo> {
  const { ffprobe } = await resolveBinaries()
  const { stdout } = await run(ffprobe, [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    path,
  ])

  const parsed = JSON.parse(stdout) as ProbeOutput
  const streams = parsed.streams ?? []
  const video = streams.find((s) => s.codec_type === "video")
  const audio = streams.find((s) => s.codec_type === "audio")

  if (!video || !video.width || !video.height) {
    throw new Error(`no decodable video stream in ${path}`)
  }

  const frameRate = parseRational(video.avg_frame_rate) || parseRational(video.r_frame_rate) || 30
  const durationSeconds =
    Number(video.duration ?? parsed.format?.duration ?? 0) || 0

  // nb_frames is absent or wrong in plenty of containers, so fall back to duration.
  const reported = Number(video.nb_frames ?? 0)
  const frameCount =
    Number.isFinite(reported) && reported > 0
      ? reported
      : Math.max(0, Math.round(durationSeconds * frameRate))

  const bitRateRaw = Number(video.bit_rate ?? parsed.format?.bit_rate ?? 0)

  return {
    width: video.width,
    height: video.height,
    frameRate,
    durationSeconds,
    frameCount,
    videoCodec: video.codec_name ?? "unknown",
    pixelFormat: video.pix_fmt ?? "unknown",
    bitRate: Number.isFinite(bitRateRaw) && bitRateRaw > 0 ? bitRateRaw : null,
    hasAudio: audio !== undefined,
    audioCodec: audio?.codec_name ?? null,
  }
}

/** FFmpeg reports frame rates as rationals such as "30000/1001". */
export function parseRational(value: string | undefined): number {
  if (!value) return 0
  const [numerator, denominator] = value.split("/")
  const n = Number(numerator)
  const d = denominator === undefined ? 1 : Number(denominator)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0
  return n / d
}
