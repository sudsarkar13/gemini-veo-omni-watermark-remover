"use client"

import { useCallback, useEffect, useState } from "react"

import type { Job, JobOptions, Settings, SystemInfo } from "@gvowr/ipc"
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
