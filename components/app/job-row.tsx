"use client"

import {
  AlertTriangle,
  Brush,
  Check,
  CircleSlash,
  Film,
  Image as ImageIcon,
  Loader2,
  SearchX,
  XCircle,
} from "lucide-react"
import type { Job } from "@gvowr/ipc"

import { Progress } from "@/components/ui/progress"
import { STATE_APPEARANCE, describeClip, truncateMiddle } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * One row in the queue.
 *
 * Status is always an icon plus a word, never colour alone — that matters for
 * colour-blind users and for the screenshots people paste into bug reports.
 */

const ICONS = {
  queued: Film,
  ready: Film,
  analysing: Loader2,
  processing: Loader2,
  done: Check,
  "done-with-skips": AlertTriangle,
  "done-with-fill": Brush,
  "no-mark-found": SearchX,
  failed: XCircle,
  cancelled: CircleSlash,
} as const

const TONES = {
  muted: "text-muted-foreground",
  active: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
} as const

export function JobRow({
  job,
  selected,
  onSelect,
}: {
  job: Job
  selected: boolean
  onSelect: () => void
}) {
  const appearance = STATE_APPEARANCE[job.state]
  // A still gets a picture icon in its resting states, so a mixed queue can be read
  // at a glance. The busy and finished icons still say what is happening to it.
  const resting = job.state === "queued" || job.state === "ready"
  const Icon = resting && job.info?.kind === "image" ? ImageIcon : ICONS[job.state]
  const busy = job.state === "analysing" || job.state === "processing"

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "w-full rounded-md border border-transparent px-2.5 py-2 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-border bg-accent" : "hover:bg-accent/50"
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          className={cn("size-3.5 shrink-0", TONES[appearance.tone], busy && "animate-spin")}
          aria-hidden
        />
        <span className="truncate text-[13px] font-medium" title={job.inputPath}>
          {truncateMiddle(job.fileName, 30)}
        </span>
      </div>

      <div className="mt-1 pl-5.5 text-[11px] text-muted-foreground tabular">
        {job.info ? describeClip(job.info) : "Reading…"}
      </div>

      <div className="mt-1 flex items-center gap-2 pl-5.5">
        <span className={cn("text-[11px]", TONES[appearance.tone])}>{appearance.label}</span>
        {busy && job.progress && (
          <span className="text-[11px] text-muted-foreground tabular">
            {Math.round(job.progress.fraction * 100)}%
          </span>
        )}
      </div>

      {busy && job.progress && (
        <Progress value={job.progress.fraction * 100} className="mt-1.5 h-1" />
      )}
    </button>
  )
}
