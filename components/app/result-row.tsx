"use client"

import { Film, FolderOpen, Image as ImageIcon, Trash2, Upload } from "lucide-react"
import type { StoredResult } from "@gvowr/ipc"

import { Button } from "@/components/ui/button"
import { formatBytes, truncateMiddle } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * One finished render.
 *
 * The row's job is to answer two questions without opening anything: is this file
 * still here, and how long have I got. Everything else is secondary — a result nobody
 * exports is deleted eventually, and that has to be visible before it happens rather
 * than discovered afterwards.
 */
export function ResultRow({
  result,
  retentionDays,
  onExport,
  onExportAs,
  onReveal,
  onRemove,
}: {
  result: StoredResult
  /** Zero means results are kept forever, so nothing counts down. */
  retentionDays: number
  onExport: () => void
  onExportAs: () => void
  onReveal: () => void
  onRemove: () => void
}) {
  const exported = result.exportedTo !== null
  const Icon = result.kind === "image" ? ImageIcon : Film

  return (
    <div className="rounded-md border border-transparent px-2.5 py-2 hover:bg-accent/50">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate text-[13px] font-medium" title={result.sourcePath}>
          {truncateMiddle(result.fileName, 28)}
        </span>
      </div>

      <div className="mt-0.5 pl-5.5 text-[11px] text-muted-foreground tabular">
        {exported ? (
          <span className="truncate" title={result.exportedTo ?? undefined}>
            Exported to {truncateMiddle(result.exportedTo ?? "", 30)}
          </span>
        ) : (
          <span>
            {formatBytes(result.sizeBytes)} · {expiry(result, retentionDays)}
          </span>
        )}
      </div>

      <div className="mt-1 flex items-center gap-1 pl-4">
        {!exported && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[11px]"
              onClick={onExport}
            >
              <Upload className="size-3" />
              Export
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              onClick={onExportAs}
            >
              Export as…
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Show in folder"
          onClick={onReveal}
        >
          <FolderOpen className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-6", !exported && "text-destructive/80 hover:text-destructive")}
          aria-label="Delete result"
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

/**
 * How long this result has left, in the plainest words available.
 *
 * Counting in days rather than showing a date, because the question being answered is
 * "do I need to deal with this now", not "when exactly was this made".
 */
function expiry(result: StoredResult, retentionDays: number): string {
  if (retentionDays <= 0) return "kept until you delete it"
  const elapsed = (Date.now() - result.createdAt) / (24 * 60 * 60 * 1000)
  const left = Math.ceil(retentionDays - elapsed)
  if (left <= 0) return "clears at any moment"
  if (left === 1) return "clears tomorrow"
  return `clears in ${left} days`
}
