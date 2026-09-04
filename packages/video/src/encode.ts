import { once } from "node:events"
import type { Frame } from "@gvowr/engine"

import { resolveBinaries, spawnStreaming } from "./ffmpeg.ts"
import type { VideoInfo } from "./probe.ts"

/**
 * Encoding corrected frames back into a container.
 *
 * Audio is stream-copied from the source rather than re-encoded: it is untouched by
 * anything we do, and re-encoding would lose quality for no reason. The source is
 * opened a second time purely to supply that stream.
 */

export type EncoderChoice = "auto" | "software" | "hardware"

export interface EncodeOptions {
  /** Constant rate factor. Lower is better; 14 matches prior art's default. */
  readonly crf?: number
  readonly preset?: string
  readonly encoder?: EncoderChoice
  /** Copy audio from this file. Usually the original input. */
  readonly audioFrom?: string
  readonly onProgress?: (framesWritten: number) => void
}

export interface EncodeResult {
  readonly framesWritten: number
  readonly audioCopied: boolean
}

export async function encodeFrames(
  frames: AsyncIterable<Frame>,
  info: VideoInfo,
  output: string,
  options: EncodeOptions = {}
): Promise<EncodeResult> {
  const { ffmpeg } = await resolveBinaries()
  const crf = options.crf ?? 14
  const preset = options.preset ?? "slow"
  const copyAudio = Boolean(options.audioFrom && info.hasAudio)

  const args = [
    "-v", "error",
    "-y",
    "-f", "rawvideo",
    "-pix_fmt", "rgb24",
    "-s", `${info.width}x${info.height}`,
    "-framerate", String(info.frameRate),
    "-i", "-",
  ]

  if (copyAudio) args.push("-i", options.audioFrom as string, "-map", "0:v:0", "-map", "1:a:0?")

  args.push(
    "-c:v", videoEncoder(options.encoder ?? "auto"),
    "-crf", String(crf),
    "-preset", preset,
    // yuv420p because anything else is unplayable in a depressing number of players.
    "-pix_fmt", "yuv420p",
  )
  if (copyAudio) args.push("-c:a", "copy")
  args.push("-movflags", "+faststart", output)

  const child = spawnStreaming(ffmpeg, args)
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })

  const finished = new Promise<number>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve(0)
      else reject(new Error(`ffmpeg encode failed with code ${code}\n${stderr.trim()}`))
    })
  })

  let framesWritten = 0
  try {
    for await (const frame of frames) {
      const payload = toRgb(frame)
      // Respect backpressure: without waiting for drain, a fast producer buffers the
      // entire clip in the pipe and the memory saved by streaming is given straight
      // back.
      if (!child.stdin.write(payload)) await once(child.stdin, "drain")
      framesWritten++
      options.onProgress?.(framesWritten)
    }
    child.stdin.end()
  } catch (error) {
    child.stdin.destroy()
    child.kill("SIGKILL")
    throw error
  }

  await finished
  return { framesWritten, audioCopied: copyAudio }
}

function videoEncoder(choice: EncoderChoice): string {
  if (choice === "hardware") return process.platform === "darwin" ? "h264_videotoolbox" : "h264_nvenc"
  // Auto stays on libx264. Hardware encoders are faster but noticeably worse at a
  // given bitrate, and this is the last step before the user's final file.
  return "libx264"
}

function toRgb(frame: Frame): Uint8Array {
  if (frame.channels === 3) {
    return new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.length)
  }
  const pixels = frame.width * frame.height
  const out = new Uint8Array(pixels * 3)
  for (let i = 0; i < pixels; i++) {
    out[i * 3] = frame.data[i * 4] as number
    out[i * 3 + 1] = frame.data[i * 4 + 1] as number
    out[i * 3 + 2] = frame.data[i * 4 + 2] as number
  }
  return out
}
