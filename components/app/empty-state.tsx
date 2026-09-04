"use client"

import { AlertTriangle, Upload } from "lucide-react"
import type { SystemInfo } from "@gvowr/ipc"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

/**
 * First run.
 *
 * States the two things that actually distinguish this tool — everything is local,
 * and there is no size limit — once, plainly, and then gets out of the way. A missing
 * FFmpeg is a packaging fault and is phrased as one rather than as user error.
 */
export function EmptyState({ system, onAdd }: { system: SystemInfo | null; onAdd: () => void }) {
  return (
    <section className="flex min-w-0 flex-1 items-center justify-center p-8">
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        <div className="flex size-14 items-center justify-center rounded-full border border-dashed border-border bg-surface">
          <Upload className="size-6 text-muted-foreground" aria-hidden />
        </div>

        <div className="flex flex-col gap-2">
          <h1 className="text-[17px] font-semibold">Drop a video to begin</h1>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Removes the visible Gemini and Veo watermark using exact maths — no blurring,
            no cropping, no generated pixels. Everything happens on this machine, and
            there is no file-size limit.
          </p>
        </div>

        <Button onClick={onAdd}>
          <Upload className="size-4" />
          Choose videos
        </Button>

        <p className="text-[11px] text-muted-foreground">MP4, MOV, MKV and WebM</p>

        {system && !system.ffmpegAvailable && (
          <Alert variant="destructive" className="text-left">
            <AlertTriangle className="size-4" />
            <AlertTitle>FFmpeg is missing from this build</AlertTitle>
            <AlertDescription>
              <span className="text-[11px]">{system.ffmpegError}</span>
            </AlertDescription>
          </Alert>
        )}
      </div>
    </section>
  )
}
