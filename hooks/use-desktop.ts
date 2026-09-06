"use client"

import { useCallback, useEffect, useState } from "react"

import type {
  ClipMedia,
  FilmstripWindow,
  Job,
  JobOptions,
  Settings,
  SystemInfo,
} from "@gvowr/ipc"
import { DEFAULT_SETTINGS } from "@gvowr/ipc"

import { desktop } from "@/lib/desktop"

/**
 * React bindings over the Electron bridge.
 *
 * Job state lives in the main process and arrives as whole snapshots, so these hooks
 * never merge or reconcile — they replace. One source of truth, and no chance of the
 * renderer's idea of a job drifting from the queue's.
 */

export function useJobs(): {
  jobs: Job[]
  addFiles: () => Promise<void>
  addPaths: (paths: string[]) => Promise<void>
  remove: (id: string) => Promise<void>
  clearFinished: () => Promise<void>
  start: (id: string, options?: JobOptions) => Promise<void>
  cancel: (id: string) => Promise<void>
  reveal: (id: string) => Promise<void>
} {
  const [jobs, setJobs] = useState<Job[]>([])

  useEffect(() => {
    const api = desktop()
    let cancelled = false

    void api.listJobs().then((initial) => {
      if (!cancelled) setJobs(initial)
    })

    // The unsubscribe returned by the bridge is what keeps listeners from stacking
    // up across fast-refresh reloads during development.
    const unsubscribe = api.onJobsChanged(setJobs)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const api = desktop()

  return {
    jobs,
    addFiles: useCallback(async () => {
      await desktop().addFiles()
    }, []),
    addPaths: useCallback(async (paths: string[]) => {
      await desktop().addPaths(paths)
    }, []),
    remove: useCallback(async (id: string) => desktop().removeJob(id), []),
    clearFinished: useCallback(async () => desktop().clearFinished(), []),
    start: useCallback(async (id: string, options?: JobOptions) => {
      await desktop().startJob(id, options)
    }, []),
    cancel: useCallback(async (id: string) => desktop().cancelJob(id), []),
    reveal: useCallback(async (id: string) => api.revealOutput(id), [api]),
  }
}

export function useSystemInfo(): SystemInfo | null {
  const [info, setInfo] = useState<SystemInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    void desktop()
      .systemInfo()
      .then((value) => {
        if (!cancelled) setInfo(value)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return info
}

export function useSettings(): {
  settings: Settings
  update: (partial: Partial<Settings>) => Promise<void>
} {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)

  useEffect(() => {
    let cancelled = false
    void desktop()
      .getSettings()
      .then((value) => {
        if (!cancelled) setSettings(value)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = useCallback(async (partial: Partial<Settings>) => {
    setSettings(await desktop().setSettings(partial))
  }, [])

  return { settings, update }
}

/**
 * Applies the theme choice to the document.
 *
 * "system" follows the OS rather than freezing whatever it was at load, so the app
 * changes with the desktop around it.
 */
export function useTheme(theme: Settings["theme"]): void {
  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia("(prefers-color-scheme: light)")

    const apply = (): void => {
      const light = theme === "light" || (theme === "system" && media.matches)
      root.classList.toggle("dark", !light)
    }

    apply()
    if (theme !== "system") return
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [theme])
}

/**
 * Loads the playable URLs, filmstrip and waveform for one clip.
 *
 * Reloads when the job produces a new result, so the "after" side of the comparison
 * shows the render that just finished rather than a stale one.
 */
export function useClipMedia(jobId: string | null, resultKey: string | null): ClipMedia | null {
  // Stored with the job it belongs to, so switching clips reads as "not loaded yet"
  // by derivation rather than needing the effect to clear it first. That also removes
  // the flash of the previous clip's media while the next one loads.
  const [loaded, setLoaded] = useState<{ jobId: string; media: ClipMedia | null } | null>(null)

  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    void desktop()
      .getMedia(jobId)
      .then((media) => {
        if (!cancelled) setLoaded({ jobId, media })
      })
    return () => {
      cancelled = true
    }
  }, [jobId, resultKey])

  return loaded && loaded.jobId === jobId ? loaded.media : null
}

/**
 * A denser filmstrip for the window the timeline is currently showing.
 *
 * Requests are debounced and the previous window is kept until the next one arrives,
 * so scrubbing a zoomed timeline neither floods the main process with FFmpeg runs nor
 * blinks the strip empty between them. Null means "nothing better than the clip-wide
 * strip is available" — the caller falls back to that rather than showing a gap.
 */
export function useFilmstripWindow(
  jobId: string | null,
  request: { fromSeconds: number; toSeconds: number; count: number } | null
): FilmstripWindow | null {
  const [window, setWindow] = useState<{ jobId: string; strip: FilmstripWindow } | null>(null)

  // Primitives rather than the object, so an identical request re-created on every
  // render does not re-trigger the effect.
  const from = request?.fromSeconds ?? 0
  const to = request?.toSeconds ?? 0
  const count = request?.count ?? 0
  const wanted = request !== null

  useEffect(() => {
    if (!jobId || !wanted) return
    let cancelled = false
    const timer = setTimeout(() => {
      void desktop()
        .getFilmstrip(jobId, from, to, count)
        .then((strip) => {
          if (!cancelled && strip) setWindow({ jobId, strip })
        })
    }, FILMSTRIP_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [jobId, wanted, from, to, count])

  if (!wanted) return null
  return window && window.jobId === jobId ? window.strip : null
}

/** Long enough that a drag across the timeline asks for one window, not thirty. */
const FILMSTRIP_DEBOUNCE_MS = 180
