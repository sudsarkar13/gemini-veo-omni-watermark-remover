import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { access, constants } from "node:fs/promises"
import { delimiter, join } from "node:path"

/**
 * Locating and invoking the FFmpeg binaries.
 *
 * FFmpeg is used for I/O only — demux, decode, encode. It never performs removal.
 *
 * Resolution order puts the bundled sidecar first so a packaged build is
 * self-contained and reproducible, and falls back to a system install for
 * development. A missing binary in a packaged app is a packaging fault, and the error
 * says so rather than blaming the user.
 */

export interface BinaryPaths {
  readonly ffmpeg: string
  readonly ffprobe: string
}

let cached: BinaryPaths | null = null

/** Overrides discovery. Set by the desktop app to point at its bundled sidecar. */
export function setBinaryPaths(paths: BinaryPaths): void {
  cached = paths
}

export async function resolveBinaries(): Promise<BinaryPaths> {
  if (cached) return cached

  const ffmpeg = await findBinary("ffmpeg", process.env["GVOWR_FFMPEG"])
  const ffprobe = await findBinary("ffprobe", process.env["GVOWR_FFPROBE"])
  cached = { ffmpeg, ffprobe }
  return cached
}

async function findBinary(name: string, override: string | undefined): Promise<string> {
  const candidates: string[] = []
  if (override) candidates.push(override)

  const bundled = process.env["GVOWR_SIDECAR_DIR"]
  if (bundled) candidates.push(join(bundled, binaryName(name)))

  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir) candidates.push(join(dir, binaryName(name)))
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(
    `${name} was not found. Looked in GVOWR_SIDECAR_DIR and PATH. ` +
      `In a packaged build this means the sidecar is missing from the bundle.`
  )
}

function binaryName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name
}

export interface RunResult {
  readonly stdout: string
  readonly stderr: string
}

/** Runs a binary to completion and collects its output. For short commands only. */
export function run(binary: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args])
    let stdout = ""
    let stderr = ""

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })

    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr })
      // FFmpeg writes diagnostics to stderr, so surface it verbatim: the demuxer's
      // own message is far more useful than anything we could paraphrase.
      else reject(new Error(`${binary} exited with code ${code}\n${stderr.trim()}`))
    })
  })
}

export function spawnStreaming(
  binary: string,
  args: readonly string[]
): ChildProcessWithoutNullStreams {
  return spawn(binary, [...args], { stdio: ["pipe", "pipe", "pipe"] })
}
