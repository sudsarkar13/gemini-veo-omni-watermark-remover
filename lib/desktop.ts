"use client"

import type { DesktopApi, Job, JobProgress, Settings, SystemInfo } from "@gvowr/ipc"
import { DEFAULT_SETTINGS } from "@gvowr/ipc"

/**
 * Access to the Electron bridge, with a browser fallback.
 *
 * The renderer is also served by `next dev` in an ordinary browser during UI work,
 * where `window.gvowr` does not exist. Rather than scattering optional chaining
 * through every component, this returns a stub that reports an empty queue and a
 * clear reason — so the layout can be developed in a browser and the app tells you
 * why nothing happens instead of throwing.
 */

declare global {
  interface Window {
    gvowr?: DesktopApi
  }
}

const browserStub: DesktopApi = {
  addFiles: async () => [],
  addPaths: async () => [],
  listJobs: async () => [],
  removeJob: async () => {},
  clearFinished: async () => {},
  startJob: async () => {},
  cancelJob: async () => {},
  revealOutput: async () => {},
  getMedia: async () => null,
  getFilmstrip: async () => null,
  systemInfo: async (): Promise<SystemInfo> => ({
    platform: "darwin",
    arch: "browser",
    cores: 0,
    totalMemoryBytes: 0,
    freeMemoryBytes: 0,
    appVersion: "dev",
    ffmpegAvailable: false,
    ffmpegError: "Running in a browser. Launch the desktop app to process video.",
  }),
  getSettings: async (): Promise<Settings> => DEFAULT_SETTINGS,
  setSettings: async (partial) => ({ ...DEFAULT_SETTINGS, ...partial }),
  minimiseWindow: () => {},
  maximiseWindow: () => {},
  closeWindow: () => {},
  onJobsChanged: () => () => {},
  onJobProgress: () => () => {},
}

export function desktop(): DesktopApi {
  if (typeof window === "undefined") return browserStub
  return window.gvowr ?? browserStub
}

export function isDesktop(): boolean {
  return typeof window !== "undefined" && window.gvowr !== undefined
}

export type { Job, JobProgress, Settings, SystemInfo }
