"use client"

import { FolderPlus, Trash2 } from "lucide-react"
import type { Job } from "@gvowr/ipc"

import { JobRow } from "@/components/app/job-row"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"

/**
 * The persistent queue.
 *
 * Kept visible at all times rather than swapped out for a detail view, so batch
 * progress stays legible while inspecting any single clip.
 */
export function QueueSidebar({
  jobs,
  selectedId,
  onSelect,
  onAdd,
  onClearFinished,
}: {
  jobs: Job[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onClearFinished: () => void
}) {
  const finished = jobs.filter((job) =>
    ["done", "done-with-skips", "no-mark-found", "failed", "cancelled"].includes(job.state)
  ).length

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center justify-between px-3 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Queue
        </h2>
        <span className="text-[11px] text-muted-foreground tabular">{jobs.length}</span>
      </div>
      <Separator />

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1 p-2">
          {jobs.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-muted-foreground">
              Nothing queued yet.
              <br />
              Drop files anywhere, or add them below.
            </p>
          ) : (
            jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                selected={job.id === selectedId}
                onSelect={() => onSelect(job.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <Separator />
      <div className="flex flex-col gap-1.5 p-2">
        <Button variant="secondary" size="sm" className="justify-start" onClick={onAdd}>
          <FolderPlus className="size-4" />
          Add files
        </Button>
        {finished > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="justify-start text-muted-foreground"
            onClick={onClearFinished}
          >
            <Trash2 className="size-4" />
            Clear finished ({finished})
          </Button>
        )}
      </div>
    </aside>
  )
}
