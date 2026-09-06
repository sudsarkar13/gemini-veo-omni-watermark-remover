"use client"

import { FolderPlus, Trash2 } from "lucide-react"
import { useState } from "react"
import type { Job, StoredResult } from "@gvowr/ipc"

import { JobRow } from "@/components/app/job-row"
import { ResultRow } from "@/components/app/result-row"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

/**
 * The persistent queue, and the results it has produced.
 *
 * Kept visible at all times rather than swapped out for a detail view, so batch
 * progress stays legible while inspecting any single clip.
 *
 * Results share the sidebar as a second tab rather than living somewhere else: they
 * are the same list of files one step further on, and a finished render that has not
 * been exported yet is exactly the sort of thing that gets forgotten if it is filed
 * away behind a menu.
 */
export function QueueSidebar({
  jobs,
  results,
  retentionDays,
  selectedId,
  onSelect,
  onAdd,
  onClearFinished,
  onExport,
  onExportAs,
  onRevealResult,
  onRemoveResult,
}: {
  jobs: Job[]
  results: StoredResult[]
  retentionDays: number
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onClearFinished: () => void
  onExport: (id: string) => void
  onExportAs: (id: string) => void
  onRevealResult: (id: string) => void
  onRemoveResult: (id: string) => void
}) {
  const [tab, setTab] = useState<"queue" | "results">("queue")
  const waiting = results.filter((result) => result.exportedTo === null).length
  const finished = jobs.filter((job) =>
    ["done", "done-with-skips", "done-with-fill", "no-mark-found", "failed", "cancelled"].includes(
      job.state
    )
  ).length

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center gap-1 px-2 py-2">
        <Tab active={tab === "queue"} onClick={() => setTab("queue")} count={jobs.length}>
          Queue
        </Tab>
        <Tab
          active={tab === "results"}
          onClick={() => setTab("results")}
          count={results.length}
          // The badge counts what is still waiting to be exported, because that is the
          // number with a deadline attached to it.
          highlight={waiting > 0}
        >
          Results
        </Tab>
      </div>
      <Separator />

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1 p-2">
          {tab === "queue" ? (
            jobs.length === 0 ? (
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
            )
          ) : results.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-muted-foreground">
              No results yet.
              <br />
              Finished removals are kept here until you export them.
            </p>
          ) : (
            results.map((result) => (
              <ResultRow
                key={result.id}
                result={result}
                retentionDays={retentionDays}
                onExport={() => onExport(result.id)}
                onExportAs={() => onExportAs(result.id)}
                onReveal={() => onRevealResult(result.id)}
                onRemove={() => onRemoveResult(result.id)}
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
        {tab === "queue" && finished > 0 && (
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

function Tab({
  active,
  count,
  highlight,
  onClick,
  children,
}: {
  active: boolean
  count: number
  highlight?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5",
        "text-[11px] font-semibold uppercase tracking-wider transition-colors",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
      <span
        className={cn(
          "tabular",
          highlight && !active ? "text-warning" : "text-muted-foreground"
        )}
      >
        {count}
      </span>
    </button>
  )
}
