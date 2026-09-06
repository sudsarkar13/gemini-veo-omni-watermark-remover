import { once } from "node:events"
import { stat } from "node:fs/promises"
import { extname } from "node:path"

import {
  createPlanner,
  renderFrame,
  type AlphaMap,
  type ClipPlan,
  type Frame,
  type PlanOptions,
  type Rect,
  type RenderOptions,
} from "@gvowr/engine"

import { resolveBinaries, run, spawnStreaming } from "./ffmpeg.ts"

/**
 * Still images: the same engine, one frame.
 *
 * Gemini stamps its images with the same kind of composited overlay it stamps on
 * video, and detection, reversibility verification and reverse blending have always
 * operated on a single frame. So nothing here is a new algorithm — this module is the
 * I/O and the decisions a still needs that a clip does not.
 *
 * Those decisions are all consequences of one fact: there are no neighbouring frames.
 * Nothing can be tracked, nothing can be interpolated, and the reversibility verifier
 * is the only thing standing between a bright patch of content and a diamond
 * subtracted out of it. See `PLAN.md` §5.
 */

export type ImageFormat = "png" | "jpeg" | "webp"

/** Extensions we will open. Anything else is refused rather than guessed at. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const

export interface ImageInfo {
  readonly width: number
  readonly height: number
  /** FFmpeg's name for the source codec: `png`, `mjpeg`, `webp`. */
  readonly codec: string
  readonly pixelFormat: string
  /** The format the result will be written in — the input's, never a substitution. */
  readonly format: ImageFormat
  readonly hasAlpha: boolean
  readonly sizeBytes: number
  /**
   * True when writing the result cannot preserve untouched pixels exactly.
   *
   * JPEG only. Editing a JPEG means re-encoding the whole image, so pixels nowhere
   * near the mark change slightly. That is not a defect to hide — it is a fact about
   * the format, and the UI says it in words.
   */
  readonly lossyRoundTrip: boolean
}

/**
 * Pixel formats that carry transparency.
 *
 * Listed rather than sniffed for an "a": `gray` and `pal8` would both pass a substring
 * test, and mistaking an opaque image for a transparent one silently adds a channel to
 * every PNG we write. `pal8` is here deliberately — a palette may carry alpha, and the
 * safe assumption is that it does.
 */
const ALPHA_PIXEL_FORMATS = /^(rgba|bgra|argb|abgr|ya|yuva|gbrap|pal8|rgba64|bgra64)/

export function imageFormatFor(path: string): ImageFormat | null {
  const extension = extname(path).slice(1).toLowerCase()
  if (extension === "png") return "png"
  if (extension === "jpg" || extension === "jpeg") return "jpeg"
  if (extension === "webp") return "webp"
  return null
}

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  pix_fmt?: string
}

export async function probeImage(path: string): Promise<ImageInfo> {
  const format = imageFormatFor(path)
  if (!format) throw new Error(`not an image this tool reads: ${path}`)

  const { ffprobe } = await resolveBinaries()
  const { stdout } = await run(ffprobe, [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    path,
  ])

  const parsed = JSON.parse(stdout) as { streams?: ProbeStream[] }
  const stream = (parsed.streams ?? []).find((candidate) => candidate.codec_type === "video")
  if (!stream?.width || !stream.height) {
    throw new Error(`no decodable image in ${path}`)
  }

  const pixelFormat = stream.pix_fmt ?? "rgb24"
  const { size } = await stat(path)

  return {
    width: stream.width,
    height: stream.height,
    codec: stream.codec_name ?? "unknown",
    pixelFormat,
    format,
    hasAlpha: ALPHA_PIXEL_FORMATS.test(pixelFormat),
    sizeBytes: size,
    lossyRoundTrip: format === "jpeg",
  }
}

/**
 * Decodes an image to one RGBA frame.
 *
 * Always RGBA, whatever the source: the engine writes only the first three channels
 * and leaves the fourth exactly as it found it, so carrying alpha through costs one
 * byte per pixel and removes any question of losing transparency. The output side
 * decides whether to write that channel back out.
 */
export async function decodeImage(path: string, info?: ImageInfo): Promise<Frame> {
  const meta = info ?? (await probeImage(path))
  const { ffmpeg } = await resolveBinaries()

  const child = spawnStreaming(ffmpeg, [
    "-v", "error",
    "-nostdin",
    "-i", path,
    "-frames:v", "1",
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-",
  ])

  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })

  const chunks: Uint8Array[] = []
  let received = 0
  for await (const chunk of child.stdout as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
    received += chunk.length
  }
  const [code] = (await once(child, "close")) as [number | null]
  if (code !== 0 && code !== null) {
    throw new Error(`ffmpeg could not decode ${path}\n${stderr.trim()}`)
  }

  const expected = meta.width * meta.height * 4
  if (received !== expected) {
    // Silence here would mean handing the engine a frame whose rows are offset from
    // where it thinks they are, and it would happily "remove" a mark from nowhere.
    throw new Error(
      `decoded ${received} bytes from ${path} but ${meta.width}x${meta.height} needs ${expected}`
    )
  }

  const data = new Uint8ClampedArray(expected)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }

  return { width: meta.width, height: meta.height, channels: 4, data }
}

/**
 * Encoders this FFmpeg actually has, by output format.
 *
 * Not every build ships a WebP encoder — Homebrew's, for one, decodes WebP and cannot
 * write it — so the encoder is looked up rather than assumed. A missing one is a
 * packaging fault and is reported as one: substituting a different format behind the
 * user's back would hand them a PNG named `.webp`, and silently changing someone's
 * file type is exactly the kind of quiet liberty this project does not take.
 */
let encoderCache: Set<string> | null = null

async function availableEncoders(): Promise<Set<string>> {
  if (encoderCache) return encoderCache
  const { ffmpeg } = await resolveBinaries()
  const { stdout } = await run(ffmpeg, ["-hide_banner", "-encoders"])
  const names = new Set<string>()
  for (const line of stdout.split("\n")) {
    // Lines look like " V..... png    PNG (Portable Network Graphics) image".
    const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line)
    if (match?.[1]) names.add(match[1])
  }
  encoderCache = names
  return names
}

async function encoderFor(format: ImageFormat): Promise<string> {
  const available = await availableEncoders()
  const candidates =
    format === "png" ? ["png"] : format === "jpeg" ? ["mjpeg"] : ["libwebp", "webp"]

  for (const candidate of candidates) {
    if (available.has(candidate)) return candidate
  }
  throw new Error(
    `this build of FFmpeg cannot write ${format} — looked for ${candidates.join(" or ")}. ` +
      `In a packaged build this means the sidecar was built without it.`
  )
}

/** Whether the result of a run on this image could actually be written back out. */
export async function canWrite(format: ImageFormat): Promise<boolean> {
  try {
    await encoderFor(format)
    return true
  } catch {
    return false
  }
}

export interface EncodeImageOptions {
  /** Copies what metadata FFmpeg can carry from the original file. */
  readonly metadataFrom?: string
  /** JPEG quality, 2 (best) to 31. Ignored for lossless formats. */
  readonly jpegQuality?: number
}

/**
 * Writes a frame back out in its own format.
 *
 * PNG and WebP are written losslessly, so every pixel the engine did not touch is
 * bit-identical to the one that came in. JPEG has no such option — the whole image is
 * re-encoded — so it is written at the encoder's best quality with chroma
 * subsampling off, which is the least destructive thing the format allows.
 */
export async function encodeImage(
  frame: Frame,
  output: string,
  info: ImageInfo,
  options: EncodeImageOptions = {}
): Promise<void> {
  const { ffmpeg } = await resolveBinaries()
  // Checked before the frame is piped, so a missing encoder fails as a clear message
  // rather than as a broken pipe part-way through a write.
  const encoder = await encoderFor(info.format)

  const args = [
    "-v", "error",
    "-y",
    "-f", "rawvideo",
    "-pix_fmt", frame.channels === 4 ? "rgba" : "rgb24",
    "-s", `${frame.width}x${frame.height}`,
    "-i", "-",
  ]

  if (options.metadataFrom) args.push("-i", options.metadataFrom, "-map", "0:v:0", "-map_metadata", "1")

  args.push("-frames:v", "1")

  if (info.format === "png") {
    args.push("-c:v", encoder, "-pix_fmt", info.hasAlpha ? "rgba" : "rgb24")
  } else if (info.format === "webp") {
    args.push("-c:v", encoder, "-lossless", "1", "-pix_fmt", info.hasAlpha ? "bgra" : "bgr24")
  } else {
    // yuvj444p rather than the usual yuvj420p: chroma subsampling would blur colour
    // across the very edges we just corrected.
    args.push("-c:v", encoder, "-q:v", String(options.jpegQuality ?? 2), "-pix_fmt", "yuvj444p")
  }

  args.push(output)

  const child = spawnStreaming(ffmpeg, args)
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })

  const finished = once(child, "close") as Promise<[number | null]>
  await new Promise<void>((resolve, reject) => {
    child.stdin.write(frame.data, (error) => (error ? reject(error) : resolve()))
  })
  child.stdin.end()

  const [code] = await finished
  if (code !== 0 && code !== null) {
    throw new Error(`ffmpeg could not write ${output}\n${stderr.trim()}`)
  }
}

export interface ProcessImageOptions extends PlanOptions, EncodeImageOptions, RenderOptions {}

export interface ImageRegion {
  readonly rect: Rect
  readonly alpha: number
  readonly confidence: number
}

export interface ProcessImageResult {
  readonly info: ImageInfo
  readonly plan: ClipPlan
  /** Where the mark was found, measured — empty when nothing verified. */
  readonly regions: readonly ImageRegion[]
  readonly applied: number
  /** Regions found but declined, e.g. judged occluded. */
  readonly skipped: number
  /**
   * Regions synthesised rather than recovered, when the fill was asked for.
   *
   * Counted apart from `applied` wherever it goes: a corrected region is the pixels
   * that were there, a filled one is a plausible guess.
   */
  readonly filled: number
  /** False means the original was left alone and nothing was written. */
  readonly written: boolean
  /** Why nothing was written, in a form the UI can turn into a sentence. */
  readonly reason: "no-mark-found" | "not-invertible" | null
}

/**
 * Finds and removes the mark on a single image.
 *
 * Nothing is written when nothing verifies. A clip with five bad frames is still worth
 * producing with those frames reported; an image with one bad frame is just a bad
 * image, and writing it would be the silent invention this project exists not to do.
 */
export async function processImage(
  input: string,
  output: string,
  template: AlphaMap,
  options: ProcessImageOptions = {}
): Promise<ProcessImageResult> {
  const info = await probeImage(input)

  // The result is written in the input's format, so the output path has to name that
  // format. Otherwise FFmpeg picks its muxer from the extension, gets handed a stream
  // in another codec, and fails halfway through with a message about neither file.
  const requested = imageFormatFor(output)
  if (requested !== info.format) {
    throw new Error(
      `a ${info.format} is written back as ${info.format}, but the output is named ` +
        `${requested ?? (extname(output) || "nothing")}: ${output}`
    )
  }

  const frame = await decodeImage(input, info)

  // Sweep every frame — there is one — and let the corner priors seed it. On a still
  // a full-frame search costs a fraction of a second, so looking only where the mark
  // usually is would be a saving worth nothing.
  const planner = createPlanner(template, { mode: "auto", sweepInterval: 1, ...options })
  planner.push(frame)
  const plan = planner.finish()

  const regions: ImageRegion[] = []
  for (const track of plan.tracks) {
    const entry = track.frames.get(0)
    if (entry) regions.push({ rect: entry.rect, alpha: entry.alpha, confidence: entry.confidence })
  }

  const report = renderFrame(frame, plan, 0, template, {
    ...(options.fill !== undefined ? { fill: options.fill } : {}),
    ...(options.fillOptions ? { fillOptions: options.fillOptions } : {}),
  })

  // A filled region is a change to the image, so there is something to write — but it
  // is never counted as a correction, and the caller is told which it got.
  if (report.applied === 0 && report.filled === 0) {
    return {
      info,
      plan,
      regions,
      applied: 0,
      skipped: report.skipped,
      filled: 0,
      written: false,
      // A region the user drew and the verifier refused is a different answer from
      // "nothing here": it is the case the fill exists for.
      reason: report.skipped > 0 || plan.refusals.length > 0 ? "not-invertible" : "no-mark-found",
    }
  }

  await encodeImage(frame, output, info, { metadataFrom: input, ...options })

  return {
    info,
    plan,
    regions,
    applied: report.applied,
    skipped: report.skipped,
    filled: report.filled,
    written: true,
    reason: null,
  }
}
