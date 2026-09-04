"use client"

import { Minus, Settings2, Square, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { desktop } from "@/lib/desktop"
import { cn } from "@/lib/utils"

/**
 * Custom title bar for the frameless window.
 *
 * macOS keeps its native traffic lights (the window is `hiddenInset`), so the left
 * side is padded to clear them and no controls are drawn. Windows and Linux get our
 * own buttons. Every interactive element opts out of the drag region, or it would be
 * unclickable.
 */
export function TitleBar({ platform }: { platform: string; }) {
  const isMac = platform === "darwin"

  return (
    <header
      className={cn(
        "drag-region flex h-9 shrink-0 items-center justify-between border-b border-border bg-sidebar select-none",
        isMac ? "pl-20 pr-2" : "px-2"
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-muted-foreground">
          Gemini/Veo Watermark Remover
        </span>
      </div>

      <div className="no-drag flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Settings"
          onClick={() => document.dispatchEvent(new CustomEvent("gvowr:open-settings"))}
        >
          <Settings2 className="size-4" />
        </Button>

        {!isMac && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Minimise"
              onClick={() => desktop().minimiseWindow()}
            >
              <Minus className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Maximise"
              onClick={() => desktop().maximiseWindow()}
            >
              <Square className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 hover:bg-destructive hover:text-white"
              aria-label="Close"
              onClick={() => desktop().closeWindow()}
            >
              <X className="size-4" />
            </Button>
          </>
        )}
      </div>
    </header>
  )
}
