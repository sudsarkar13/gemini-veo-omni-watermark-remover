import type { Frame } from "@gvowr/engine"

import { resolveBinaries, spawnStreaming } from "./ffmpeg.ts"
import { probe, type VideoInfo } from "./probe.ts"

/**
 * Decoding a video into raw RGB frames.
 *
 * Frames are yielded one at a time rather than collected, because a clip does not fit
 * in memory: 1080p RGB is roughly 6 MB per frame, so a minute of 30fps footage is
 * about 11 GB. The planner consumes this stream and keeps only observations.
 */

export interface DecodeOptions {
  /** Stop after this many frames. Used by the probe pass to sample cheaply. */
  readonly limit?: number
  /** Seek to this offset before decoding, in seconds. */
  readonly startSeconds?: number
  /** Decode only every Nth frame. Cheap sampling for the analysis pass. */
  readonly everyNth?: number
}

export async function* decodeFrames(
  path: string,
  info?: VideoInfo,
  options: DecodeOptions = {}
): AsyncGenerator<Frame, void, undefined> {
  const meta = info ?? (await probe(path))
  const { ffmpeg } = await resolveBinaries()

  const args = ["-v", "error", "-nostdin"]
  // Seeking before -i is the fast path: FFmpeg jumps to the nearest keyframe rather
  // than decoding and discarding everything up to the offset.
  if (options.startSeconds) args.push("-ss", String(options.startSeconds))
  args.push("-i", path)
  if (options.everyNth && options.everyNth > 1) {
    args.push("-vf", `select=not(mod(n\\,${options.everyNth}))`, "-vsync", "0")
  }
  if (options.limit) args.push("-frames:v", String(options.limit))
  args.push("-f", "rawvideo", "-pix_fmt", "rgb24", "-")

  const child = spawnStreaming(ffmpeg, args)
  const frameBytes = meta.width * meta.height * 3

  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })

  const failure = new Promise<never>((_, reject) => {
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`ffmpeg decode failed with code ${code}\n${stderr.trim()}`))
      }
    })
  })
  // The close handler above rejects on failure; without a no-op catch here an early
  // consumer break would surface as an unhandled rejection.
  failure.catch(() => {})

  // FFmpeg's stdout chunks have nothing to do with frame boundaries, so bytes are
  // accumulated until a whole frame is available.
  const pending: Uint8Array[] = []
  let pendingBytes = 0

  try {
    for await (const chunk of child.stdout as AsyncIterable<Uint8Array>) {
      pending.push(chunk)
      pendingBytes += chunk.length

      while (pendingBytes >= frameBytes) {
        const merged = concat(pending, pendingBytes)
        yield {
          width: meta.width,
          height: meta.height,
          channels: 3,
          data: new Uint8ClampedArray(merged.buffer, merged.byteOffset, frameBytes).slice(),
        }
        const rest = merged.subarray(frameBytes)
        pending.length = 0
        pendingBytes = rest.length
        if (rest.length > 0) pending.push(rest)
      }
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
  }

  if (stderr.trim() && child.exitCode !== 0 && child.exitCode !== null) {
    throw new Error(`ffmpeg decode failed\n${stderr.trim()}`)
  }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}
