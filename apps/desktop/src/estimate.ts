import { cpus, freemem, totalmem } from "node:os"

import type { ClipInfo, ResourceEstimate } from "@gvowr/ipc"

/**
 * Pre-flight resource estimation.
 *
 * This exists because the app has no file-size ceiling — a native process with
 * filesystem access is not bound by a browser tab's memory budget, so 1 GB clips are
 * ordinary. That freedom has a cost in CPU and time, and the user deserves to know
 * before starting rather than thirty minutes in.
 *
 * The numbers are coarse on purpose. Their job is to let someone close other
 * applications or pick a different drive, not to be accurate to the second, and the
 * UI must present them as estimates.
 */

/**
 * Rough per-megapixel, per-frame cost of one analysis or render pass, in
 * milliseconds on one core. Calibrated against synthetic clips; it should be
 * re-derived from real telemetry once diagnostics are collecting (docs/PLAN.md §7).
 */
const MS_PER_MEGAPIXEL_PER_PASS = 14

/** Analysis and render are two passes over the clip, plus encode overhead. */
const PASSES = 2.4

export function estimate(info: ClipInfo, concurrency = 1): ResourceEstimate {
  const cores = Math.max(1, cpus().length)
  const megapixels = (info.width * info.height) / 1_000_000
  const frames = Math.max(1, info.frameCount)

  // Work parallelises well but not perfectly, and hyperthreads are not full cores.
  const effectiveCores = Math.max(1, Math.min(cores, 8) * 0.6)
  const seconds =
    (megapixels * frames * MS_PER_MEGAPIXEL_PER_PASS * PASSES) / 1000 / effectiveCores

  // Frames are streamed, so peak memory is a working set of a few frames plus the
  // integral tables, not the whole clip.
  const frameBytes = info.width * info.height * 3
  const peakMemoryBytes = Math.round(frameBytes * 8 + megapixels * 24 * 1_000_000 * 0.05) * concurrency

  // The output is written directly; scratch space is small, but leave headroom for
  // a container roughly the size of the source.
  const tempDiskBytes = Math.round(info.sizeBytes * 1.15)

  const total = totalmem()
  const free = freemem()

  return {
    seconds,
    peakMemoryBytes,
    tempDiskBytes,
    cores,
    heavy:
      info.sizeBytes > 500 * 1024 * 1024 ||
      info.width * info.height > 3840 * 2160 * 0.9 ||
      info.durationSeconds > 300 ||
      peakMemoryBytes > total * 0.6,
    exceedsResources: peakMemoryBytes > total || peakMemoryBytes > free * 1.5,
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown"
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes}m ${rest}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
