import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { join, normalize, sep } from "node:path"
import { Readable } from "node:stream"

/**
 * Serving local media to the renderer.
 *
 * The renderer is Chromium, so it can decode h264 and aac natively — there is no need
 * to pipe frames across IPC to show a video. It only needs a URL it is allowed to
 * fetch.
 *
 * Access is by job id against a registry, never by path. A URL cannot name an
 * arbitrary file: it can only refer to something the user has already added to the
 * queue, or a thumbnail this app generated for it.
 */

export const MEDIA_SCHEME = "media"

export interface MediaEntry {
  readonly sourcePath: string
  outputPath: string | null
  thumbnailDirectory: string | null
}

const registry = new Map<string, MediaEntry>()

export function registerMedia(jobId: string, sourcePath: string): void {
  registry.set(jobId, { sourcePath, outputPath: null, thumbnailDirectory: null })
}

export function setMediaOutput(jobId: string, outputPath: string): void {
  const entry = registry.get(jobId)
  if (entry) entry.outputPath = outputPath
}

export function setMediaThumbnails(jobId: string, directory: string): void {
  const entry = registry.get(jobId)
  if (entry) entry.thumbnailDirectory = directory
}

export function unregisterMedia(jobId: string): void {
  registry.delete(jobId)
}

export function mediaUrl(jobId: string, kind: "source" | "output"): string {
  // A cache buster on the output: re-running a job writes a new file at the same path,
  // and Chromium would otherwise keep showing the previous render.
  const suffix = kind === "output" ? `?v=${Date.now()}` : ""
  return `${MEDIA_SCHEME}://${jobId}/${kind}${suffix}`
}

/**
 * Takes the extractor's actual filename rather than reconstructing it.
 *
 * Rebuilding the name here means two places have to agree on a naming scheme, and
 * when they silently disagree every thumbnail 404s while the layout still looks
 * plausible — which is exactly what happened.
 */
export function thumbnailUrl(jobId: string, fileName: string): string {
  return `${MEDIA_SCHEME}://${jobId}/thumb/${encodeURIComponent(fileName)}`
}

/** Resolves a request path to a file on disk, or null when it is not permitted. */
function resolveMediaPath(jobId: string, pathname: string): string | null {
  const entry = registry.get(jobId)
  if (!entry) return null

  const requested = decodeURIComponent(pathname).replace(/^\/+/, "")
  if (requested === "source") return entry.sourcePath
  if (requested === "output") return entry.outputPath

  if (requested.startsWith("thumb/")) {
    if (!entry.thumbnailDirectory) return null
    const candidate = normalize(join(entry.thumbnailDirectory, requested.slice("thumb/".length)))
    // Confirm the resolved path is still inside the thumbnail directory, so a crafted
    // URL cannot traverse out of it.
    if (!candidate.startsWith(entry.thumbnailDirectory + sep)) return null
    return candidate
  }

  return null
}

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
}

function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return CONTENT_TYPES[extension] ?? "application/octet-stream"
}

/**
 * Handles a media request, honouring HTTP range requests.
 *
 * Range support is not optional here. Chromium will not allow seeking in a video
 * element unless the server answers a Range request with 206 and a Content-Range
 * header — without it the scrubber is inert and the whole file has to download before
 * playback starts.
 */
export async function handleMediaRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const target = resolveMediaPath(url.hostname, url.pathname)
  if (!target) return new Response("not found", { status: 404 })

  let size: number
  try {
    size = (await stat(target)).size
  } catch {
    return new Response("not found", { status: 404 })
  }

  const contentType = contentTypeFor(target)
  const range = request.headers.get("Range")

  if (!range) {
    return new Response(Readable.toWeb(createReadStream(target)) as ReadableStream, {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-length": String(size),
        "accept-ranges": "bytes",
      },
    })
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (!match) {
    return new Response("invalid range", {
      status: 416,
      headers: { "content-range": `bytes */${size}` },
    })
  }

  const [, rawStart, rawEnd] = match
  let start = rawStart ? Number(rawStart) : 0
  let end = rawEnd ? Number(rawEnd) : size - 1

  // A suffix range ("bytes=-500") asks for the final N bytes.
  if (!rawStart && rawEnd) {
    start = Math.max(0, size - Number(rawEnd))
    end = size - 1
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new Response("range not satisfiable", {
      status: 416,
      headers: { "content-range": `bytes */${size}` },
    })
  }
  end = Math.min(end, size - 1)

  const stream = Readable.toWeb(createReadStream(target, { start, end })) as ReadableStream
  return new Response(stream, {
    status: 206,
    headers: {
      "content-type": contentType,
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
    },
  })
}
