"use client"

import { AlertTriangle, Cpu, Zap } from "lucide-react"
import type { ClipInfo, ResourceEstimate } from "@gvowr/ipc"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { formatBytes, formatDuration } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * Pre-flight resource estimate.
 *
 * There is no file-size limit here — a native app is not bound by a browser tab's
 * memory budget — but the work is genuinely expensive, and the honest thing is to say
 * so before a run rather than thirty minutes into one.
 *
 * Deliberately worded as an estimate. Its job is to let someone close other apps or
 * pick another drive, not to be accurate to the second.
 */
export function Preflight({
  info,
  estimate,
}: {
  info: ClipInfo
  estimate: ResourceEstimate
}) {
  if (estimate.exceedsResources) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>This clip may not fit in memory</AlertTitle>
        <AlertDescription>
          Estimated peak of {formatBytes(estimate.peakMemoryBytes)} exceeds what is
          available. You can still run it, but consider closing other applications
          first, or lowering quality in Advanced.
        </AlertDescription>
      </Alert>
    )
  }

  const body = (
    <span className="tabular">
      Roughly {formatDuration(estimate.seconds)} · about{" "}
      {formatBytes(estimate.peakMemoryBytes)} peak memory ·{" "}
      {formatBytes(estimate.tempDiskBytes)} disk · {estimate.cores} cores
    </span>
  )

  if (estimate.heavy) {
    return (
      <Alert className="border-warning/40 bg-warning/5 text-foreground">
        <Zap className="size-4 text-warning" />
        <AlertTitle className="text-warning">This one is heavy</AlertTitle>
        <AlertDescription className="text-muted-foreground">
          {info.width}×{info.height}
          {info.kind === "image" ? "" : ` for ${formatDuration(info.durationSeconds)}`} will
          work the CPU hard. {body}
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2",
        "text-[12px] text-muted-foreground"
      )}
    >
      <Cpu className="size-3.5 shrink-0" aria-hidden />
      <span>Estimated:</span>
      {body}
    </div>
  )
}
