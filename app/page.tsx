"use client"

import { useCallback, useMemo, useState } from "react"
import type { JobOptions } from "@gvowr/ipc"

import { ClipDetail } from "@/components/app/clip-detail"
import { EmptyState } from "@/components/app/empty-state"
import { QueueSidebar } from "@/components/app/queue-sidebar"
import { SettingsDialog } from "@/components/app/settings-dialog"
import { TitleBar } from "@/components/app/title-bar"
import { useJobs, useSettings, useSystemInfo, useTheme } from "@/hooks/use-desktop"
import { cn } from "@/lib/utils"

/**
 * Two-pane shell: a persistent queue on the left, the selected clip on the right.
 *
 * Batch and detail stay visible together, so progress on a queue of clips remains
 * legible while inspecting any one of them.
 */
export default function Page() {
  const { jobs, addFiles, addPaths, clearFinished, start, cancel, reveal } = useJobs()
  const { settings, update } = useSettings()
  const system = useSystemInfo()
  useTheme(settings.theme)

  const [chosenId, setChosenId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  // Selection is derived rather than stored. The user's explicit choice is kept, but
  // what is actually shown falls back to the first clip whenever that choice is
  // absent or has been removed from the queue. Computing it during render avoids the
  // synchronising effect — and the cascading re-render — that storing it would need.
  const selected = useMemo(
    () => jobs.find((job) => job.id === chosenId) ?? jobs[0] ?? null,
    [jobs, chosenId]
  )
  const selectedId = selected?.id ?? null

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDragging(false)
      // Electron puts the real filesystem path on the File object; a browser does not,
      // which is why dropping only works in the desktop app.
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => (file as File & { path?: string }).path)
        .filter((path): path is string => typeof path === "string" && path.length > 0)
      if (paths.length > 0) void addPaths(paths)
    },
    [addPaths]
  )

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-background text-foreground"
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <TitleBar platform={system?.platform ?? "darwin"} />

      <div className="relative flex min-h-0 flex-1">
        <QueueSidebar
          jobs={jobs}
          selectedId={selectedId}
          onSelect={setChosenId}
          onAdd={() => void addFiles()}
          onClearFinished={() => void clearFinished()}
        />

        {selected ? (
          <ClipDetail
            job={selected}
            onStart={(options: JobOptions) => void start(selected.id, options)}
            onCancel={() => void cancel(selected.id)}
            onReveal={() => void reveal(selected.id)}
          />
        ) : (
          <EmptyState system={system} onAdd={() => void addFiles()} />
        )}

        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 z-50 flex items-center justify-center",
            "border-2 border-dashed border-primary bg-primary/10 transition-opacity",
            dragging ? "opacity-100" : "opacity-0"
          )}
        >
          <span className="rounded-md bg-surface-raised px-3 py-1.5 text-[13px] font-medium">
            Drop to add
          </span>
        </div>
      </div>

      <SettingsDialog settings={settings} system={system} onChange={update} />
    </div>
  )
}
