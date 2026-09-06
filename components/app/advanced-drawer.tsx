"use client"

import { ChevronRight, RotateCcw } from "lucide-react"
import { useState } from "react"
import type { JobOptions } from "@gvowr/ipc"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { cn } from "@/lib/utils"

/**
 * Everything power users need, and nothing a first run requires.
 *
 * Collapsed by default and remembered across clips rather than per clip. The point is
 * that one obvious path exists — drop, run, done — while the controls that mature
 * tools accrete one bug report at a time stay out of the way until wanted.
 *
 * The control set here is exactly the one enumerated in docs/UI-SPEC.md §5.4.
 */

export const DEFAULT_OPTIONS: JobOptions = {
  mode: "auto",
  sweepInterval: 15,
  crf: 14,
  preset: "slow",
  encoder: "auto",
}

export function AdvancedDrawer({
  options,
  onChange,
  disabled,
  still = false,
}: {
  options: JobOptions
  onChange: (options: JobOptions) => void
  disabled: boolean
  /** A still has no encoder, no quality setting and no sweep interval to space out. */
  still?: boolean
}) {
  const [open, setOpen] = useState(false)
  const set = <K extends keyof JobOptions>(key: K, value: JobOptions[K]): void =>
    onChange({ ...options, [key]: value })

  return (
    <div className="rounded-md border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-[12px] font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        Advanced
      </button>

      {open && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border p-3">
          <Field label="Detection">
            <Select
              value={options.mode ?? "auto"}
              onValueChange={(value) => set("mode", value as JobOptions["mode"])}
              disabled={disabled}
            >
              <SelectTrigger className="h-8 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="corner">Corner only (fast)</SelectItem>
                <SelectItem value="sweep">Full-frame sweep</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {/*
            * Encoder, quality and sweep interval are video settings. On a still they
            * would be controls that do nothing, which is worse than their absence:
            * a control that is present implies it matters.
            */}
          {!still && (
            <>
          <Field label="Encoder">
            <Select
              value={options.encoder ?? "auto"}
              onValueChange={(value) => set("encoder", value as JobOptions["encoder"])}
              disabled={disabled}
            >
              <SelectTrigger className="h-8 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="software">Software (best quality)</SelectItem>
                <SelectItem value="hardware">Hardware (faster)</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field
            label={`Quality — CRF ${options.crf ?? 14}`}
            hint={qualityWord(options.crf ?? 14)}
          >
            <Slider
              value={[options.crf ?? 14]}
              min={10}
              max={28}
              step={1}
              disabled={disabled}
              onValueChange={(value) => set("crf", Array.isArray(value) ? value[0] : value)}
            />
          </Field>

          <Field label="Sweep interval" hint="Frames between full-frame searches">
            <Input
              type="number"
              min={1}
              max={120}
              className="h-8 text-[12px]"
              value={options.sweepInterval ?? 15}
              disabled={disabled}
              onChange={(event) => set("sweepInterval", Number(event.target.value) || 15)}
            />
          </Field>
            </>
          )}

          <div className="col-span-2 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => onChange(DEFAULT_OPTIONS)}
              disabled={disabled}
            >
              <RotateCcw className="size-3.5" />
              Reset to defaults
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Numbers alone do not tell anyone what CRF 14 means. */
function qualityWord(crf: number): string {
  if (crf <= 13) return "Near-lossless, large file"
  if (crf <= 18) return "High quality"
  if (crf <= 23) return "Balanced"
  return "Smaller file, visible loss"
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[11px] font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </div>
  )
}
