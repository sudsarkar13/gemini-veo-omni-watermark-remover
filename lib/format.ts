import type { ClipInfo, JobState } from "@gvowr/ipc"

/** Presentation helpers. Pure, so they are testable without a DOM. */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
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
  if (!Number.isFinite(seconds) || seconds < 0) return "—"
  if (seconds < 1) return "<1s"
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes}m ${rest}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return `${minutes}:${String(rest).padStart(2, "0")}`
}

/** Middle-truncates so both the name and its extension stay readable. */
export function truncateMiddle(value: string, max = 28): string {
  if (value.length <= max) return value
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

export function describeClip(info: ClipInfo): string {
  // A still has no duration, and printing "0s" for one would be a small lie told
  // repeatedly. Its format is the useful third fact instead.
  const middle =
    info.kind === "image"
      ? (info.image?.format ?? "image").toUpperCase()
      : formatDuration(info.durationSeconds)
  return `${info.width}×${info.height} · ${middle} · ${formatBytes(info.sizeBytes)}`
}

export interface StateAppearance {
  readonly label: string
  /** Paired with an icon in the UI: colour is never the only signal. */
  readonly tone: "muted" | "active" | "success" | "warning" | "danger"
}

export const STATE_APPEARANCE: Record<JobState, StateAppearance> = {
  queued: { label: "Queued", tone: "muted" },
  analysing: { label: "Analysing", tone: "active" },
  ready: { label: "Ready", tone: "muted" },
  processing: { label: "Processing", tone: "active" },
  done: { label: "Done", tone: "success" },
  // Deliberately distinct from "Done". Rolling this up as plain success would hide
  // exactly the frames the user most needs to look at.
  "done-with-skips": { label: "Done, some frames skipped", tone: "warning" },
  "done-with-fill": { label: "Done, some regions filled", tone: "warning" },
  "no-mark-found": { label: "No watermark found", tone: "muted" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "muted" },
}
