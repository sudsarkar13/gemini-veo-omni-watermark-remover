// See the note in main.ts on why Electron is reached through its default export.
import electron from "electron"

const { contextBridge, ipcRenderer } = electron

import {
  CHANNELS,
  EVENTS,
  type ClipMedia,
  type DesktopApi,
  type Job,
  type JobOptions,
  type JobProgress,
  type Settings,
} from "@gvowr/ipc"

/**
 * The only bridge between the renderer and the operating system.
 *
 * Context isolation is on and node integration is off, so the renderer has no
 * require, no fs, and no child_process. Everything it can do is enumerated here, and
 * each function forwards to a named channel — a compromised or buggy renderer cannot
 * reach anything that is not on this list.
 *
 * Event subscriptions return an unsubscribe function rather than exposing the raw
 * emitter, so React effects can clean up without leaking listeners across reloads.
 */
const api: DesktopApi = {
  addFiles: () => ipcRenderer.invoke(CHANNELS.jobsAdd) as Promise<Job[]>,
  addPaths: (paths) => ipcRenderer.invoke(CHANNELS.jobsAddPaths, paths) as Promise<Job[]>,
  listJobs: () => ipcRenderer.invoke(CHANNELS.jobsList) as Promise<Job[]>,
  removeJob: (id) => ipcRenderer.invoke(CHANNELS.jobsRemove, id) as Promise<void>,
  clearFinished: () => ipcRenderer.invoke(CHANNELS.jobsClearFinished) as Promise<void>,
  startJob: (id, options?: JobOptions) =>
    ipcRenderer.invoke(CHANNELS.jobsStart, id, options) as Promise<void>,
  cancelJob: (id) => ipcRenderer.invoke(CHANNELS.jobsCancel, id) as Promise<void>,
  revealOutput: (id) => ipcRenderer.invoke(CHANNELS.jobsReveal, id) as Promise<void>,
  getMedia: (id) => ipcRenderer.invoke(CHANNELS.jobsMedia, id) as Promise<ClipMedia | null>,
  systemInfo: () => ipcRenderer.invoke(CHANNELS.systemInfo),
  getSettings: () => ipcRenderer.invoke(CHANNELS.settingsGet) as Promise<Settings>,
  setSettings: (partial) => ipcRenderer.invoke(CHANNELS.settingsSet, partial) as Promise<Settings>,

  minimiseWindow: () => ipcRenderer.send(CHANNELS.windowMinimise),
  maximiseWindow: () => ipcRenderer.send(CHANNELS.windowMaximise),
  closeWindow: () => ipcRenderer.send(CHANNELS.windowClose),

  onJobsChanged: (listener: (jobs: Job[]) => void) => {
    const handler = (_event: unknown, jobs: Job[]): void => listener(jobs)
    ipcRenderer.on(EVENTS.jobsChanged, handler)
    return () => ipcRenderer.removeListener(EVENTS.jobsChanged, handler)
  },

  onJobProgress: (listener: (id: string, progress: JobProgress) => void) => {
    const handler = (_event: unknown, id: string, progress: JobProgress): void =>
      listener(id, progress)
    ipcRenderer.on(EVENTS.jobProgress, handler)
    return () => ipcRenderer.removeListener(EVENTS.jobProgress, handler)
  },
}

contextBridge.exposeInMainWorld("gvowr", api)
