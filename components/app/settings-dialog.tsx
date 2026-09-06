"use client"

import { useEffect, useState } from "react"
import type { Settings, StorageUsage, SystemInfo } from "@gvowr/ipc"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { formatBytes } from "@/lib/format"

/**
 * Settings.
 *
 * Diagnostics live here and are off by default. This is a privacy tool — the whole
 * premise is that footage never leaves the machine — so collection is opt-in, and the
 * copy says plainly what would and would not be sent.
 */
export function SettingsDialog({
  settings,
  system,
  usage,
  onChange,
  onClearResults,
  onOpenResultsFolder,
}: {
  settings: Settings
  system: SystemInfo | null
  usage: StorageUsage | null
  onChange: (partial: Partial<Settings>) => void
  onClearResults: () => void
  onOpenResultsFolder: () => void
}) {
  const [open, setOpen] = useState(false)
  // Clearing is destructive and irreversible, so it asks — inline rather than in a
  // second dialog stacked on this one.
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    const handler = (): void => setOpen(true)
    document.addEventListener("gvowr:open-settings", handler)
    return () => document.removeEventListener("gvowr:open-settings", handler)
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Everything runs on this machine. Nothing is uploaded.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Row label="Theme">
            <Select
              value={settings.theme}
              onValueChange={(value) => onChange({ theme: value as Settings["theme"] })}
            >
              <SelectTrigger className="h-8 w-40 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
              </SelectContent>
            </Select>
          </Row>

          <Row
            label="Concurrent jobs"
            hint="Processing already uses every core, so running clips in parallel mostly adds memory pressure and makes each one slower."
          >
            <Select
              value={String(settings.maxConcurrentJobs)}
              onValueChange={(value) => onChange({ maxConcurrentJobs: Number(value) })}
            >
              <SelectTrigger className="h-8 w-40 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4].map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {count}
                    {count === 1 ? " (recommended)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          <Separator />

          {/*
            * Storage. A tool that keeps your renders has to show you how much room
            * they take, where they are, and how to be rid of them — otherwise it is
            * just a folder that fills up somewhere you never look.
            */}
          <Row
            label="Keep results for"
            hint="Results are kept in the app until you export them. Anything never exported is cleared automatically after this long."
          >
            <Select
              value={String(settings.retentionDays)}
              onValueChange={(value) => onChange({ retentionDays: Number(value) })}
            >
              <SelectTrigger className="h-8 w-40 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
                <SelectItem value="0">Forever</SelectItem>
              </SelectContent>
            </Select>
          </Row>

          <Row
            label="Storage used"
            hint={usage?.directory ? usage.directory : undefined}
          >
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-muted-foreground tabular">
                {usage ? `${formatBytes(usage.bytes)} · ${usage.count} kept` : "—"}
              </span>
              <Button variant="ghost" size="sm" className="h-8 text-[12px]" onClick={onOpenResultsFolder}>
                Open folder
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-[12px] text-destructive/90 hover:text-destructive"
                disabled={!usage || usage.count === 0}
                onClick={() => setConfirmClear(true)}
              >
                Clear all
              </Button>
            </div>
          </Row>

          {confirmClear && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
              <span className="text-[12px] text-foreground">
                Delete every kept result? Exported files are not touched.
              </span>
              <div className="flex shrink-0 gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    onClearResults()
                    setConfirmClear(false)
                  }}
                >
                  Delete them
                </Button>
              </div>
            </div>
          )}

          <Separator />

          <Row
            label="Share diagnostics"
            hint="Off by default. When on, nothing is sent automatically — you see the exact report and choose to send it. Never includes your video, audio, frames, or filenames."
          >
            <Switch
              checked={settings.diagnosticsEnabled}
              onCheckedChange={(checked) => onChange({ diagnosticsEnabled: checked })}
            />
          </Row>

          <Row label="Ask how it went after a job">
            <Switch
              checked={settings.feedbackPromptEnabled}
              onCheckedChange={(checked) => onChange({ feedbackPromptEnabled: checked })}
            />
          </Row>

          {system && (
            <>
              <Separator />
              <div className="text-[11px] leading-relaxed text-muted-foreground tabular">
                Version {system.appVersion} · {system.platform}/{system.arch} ·{" "}
                {system.cores} cores · {formatBytes(system.totalMemoryBytes)} RAM
                <br />
                Removes the visible watermark only. SynthID, Google&apos;s invisible
                watermark, is out of scope.
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex flex-col gap-1">
        <Label className="text-[13px]">{label}</Label>
        {hint && <span className="text-[11px] leading-relaxed text-muted-foreground">{hint}</span>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  )
}
