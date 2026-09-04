import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { cpus, freemem, totalmem } from "node:os"
import { join, normalize, resolve, sep } from "node:path"
import { Readable } from "node:stream"
// Default import, then destructure.
//
// Electron's module is CommonJS and provides no ESM named exports, so an ES module
// main process fails to load outright. The bundle is therefore CommonJS, and the
// module is reached through the default export, which is the form that survives
// esbuild's interop wrapper regardless of how the module defines its properties.
import electron from "electron"
// Types come from the module's declarations even though the values come through the
// default export, so `BrowserWindow` stays usable as a type as well as a constructor.
import type { BrowserWindow as BrowserWindowInstance } from "electron"

const { app, BrowserWindow, dialog, ipcMain, protocol, shell } = electron

import { resolveBinaries } from "@gvowr/video"

import { CHANNELS, EVENTS, ACCEPTED_EXTENSIONS, type Job, type JobOptions, type JobProgress, type Settings, type SystemInfo } from "./ipc.ts"
import { JobQueue } from "./queue.ts"
import { SettingsStore } from "./settings.ts"

/**
 * Electron main process.
 *
 * Owns the window, the job queue, and every privileged operation. The renderer holds
 * no state of its own beyond what it renders — all job state lives here and is pushed
 * out as snapshots.
 */

// Declared rather than imported: the bundle is CommonJS, where __dirname is a
// module-scoped variable the loader provides. TypeScript treats this file as ESM
// because it has imports, so it needs telling.
declare const __dirname: string
const here = __dirname
const isDev = !app.isPackaged

/** The static Next.js export. Served over a custom scheme rather than file://. */
const rendererRoot = isDev ? resolve(here, "../../../out") : join(process.resourcesPath, "renderer")

const SCHEME = "app"

// Must be registered before the app is ready. Marking it standard gives the page a
// proper origin, which localStorage and fetch both require.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

let window: BrowserWindowInstance | null = null
let queue: JobQueue
let settings: SettingsStore

function broadcast(channel: string, ...args: unknown[]): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, ...args)
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: "#0b0b0d",
    // Frameless with a custom title bar, per the UI spec, but keeping the native
    // traffic lights on macOS so window management still feels native.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform !== "darwin"
      ? { titleBarOverlay: { color: "#0b0b0d", symbolColor: "#e6e6e9", height: 36 } }
      : {}),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      // The renderer gets no Node access at all. Everything it may do is enumerated
      // in preload.ts and reachable only through named channels.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  window.once("ready-to-show", () => window?.show())
  window.on("closed", () => {
    window = null
  })

  // Never let the app navigate itself somewhere else, and open real links in the
  // user's browser rather than inside the application window.
  window.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event: Electron.Event, url: string) => {
    if (!url.startsWith(`${SCHEME}://`)) event.preventDefault()
  })

  await window.loadURL(`${SCHEME}://local/index.html`)

  // Headless self-check for CI: confirms the protocol served the renderer and that
  // the preload bridge is actually reachable from the page, then exits. Checking the
  // process merely survived proves neither of those.
  if (process.env["GVOWR_SMOKE"] === "1") {
    const title = await window.webContents.executeJavaScript("document.title")
    const bridge = await window.webContents.executeJavaScript("typeof window.gvowr")
    const methods = await window.webContents.executeJavaScript(
      "window.gvowr ? Object.keys(window.gvowr).length : 0"
    )
    process.stdout.write(`SMOKE title=${JSON.stringify(title)} bridge=${bridge} methods=${methods}\n`)
    app.exit(bridge === "object" && methods > 0 ? 0 : 1)
  }
}

/**
 * Serves the static export.
 *
 * Paths are resolved and then checked to be inside the renderer root, so a crafted
 * URL cannot walk out of it and read arbitrary files.
 */
function registerProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    const requested = decodeURIComponent(url.pathname)
    const candidate = normalize(join(rendererRoot, requested))

    if (!candidate.startsWith(rendererRoot + sep) && candidate !== rendererRoot) {
      return new Response("forbidden", { status: 403 })
    }

    let target = candidate
    try {
      const stats = await stat(target)
      if (stats.isDirectory()) target = join(target, "index.html")
    } catch {
      // A static export has no server-side routing, so unknown paths fall back to
      // the shell and let the client router decide.
      target = join(rendererRoot, "index.html")
    }

    try {
      const stream = Readable.toWeb(createReadStream(target)) as ReadableStream
      return new Response(stream, { headers: { "content-type": contentType(target) } })
    } catch {
      return new Response("not found", { status: 404 })
    }
  })
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    woff2: "font/woff2",
    ico: "image/x-icon",
  }
  return types[extension] ?? "application/octet-stream"
}

function registerHandlers(): void {
  ipcMain.handle(CHANNELS.jobsAdd, async (): Promise<Job[]> => {
    if (!window) return []
    const result = await dialog.showOpenDialog(window, {
      title: "Add videos",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Video", extensions: [...ACCEPTED_EXTENSIONS] }],
    })
    if (result.canceled || result.filePaths.length === 0) return []
    return queue.add(result.filePaths)
  })

  ipcMain.handle(CHANNELS.jobsAddPaths, (_event, paths: string[]) => queue.add(paths))
  ipcMain.handle(CHANNELS.jobsList, () => queue.list())
  ipcMain.handle(CHANNELS.jobsRemove, (_event, id: string) => queue.remove(id))
  ipcMain.handle(CHANNELS.jobsClearFinished, () => queue.clearFinished())
  ipcMain.handle(CHANNELS.jobsCancel, (_event, id: string) => queue.cancel(id))

  ipcMain.handle(CHANNELS.jobsStart, (_event, id: string, options: JobOptions = {}) => {
    const current = settings.get()
    queue.start(id, {
      crf: current.crf,
      encoder: current.encoder,
      ...(current.outputDirectory ? { outputDirectory: current.outputDirectory } : {}),
      ...options,
    })
  })

  ipcMain.handle(CHANNELS.jobsReveal, (_event, id: string) => {
    const job = queue.list().find((candidate) => candidate.id === id)
    if (job?.result) shell.showItemInFolder(job.result.outputPath)
  })

  ipcMain.handle(CHANNELS.systemInfo, async (): Promise<SystemInfo> => {
    let ffmpegAvailable = true
    let ffmpegError: string | null = null
    try {
      await resolveBinaries()
    } catch (error) {
      ffmpegAvailable = false
      ffmpegError = error instanceof Error ? error.message : String(error)
    }
    return {
      platform: process.platform,
      arch: process.arch,
      cores: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
      appVersion: app.getVersion(),
      ffmpegAvailable,
      ffmpegError,
    }
  })

  ipcMain.handle(CHANNELS.settingsGet, () => settings.get())
  ipcMain.handle(CHANNELS.settingsSet, async (_event, partial: Partial<Settings>) => {
    const updated = await settings.set(partial)
    queue.setConcurrency(updated.maxConcurrentJobs)
    return updated
  })

  ipcMain.on(CHANNELS.windowMinimise, () => window?.minimize())
  ipcMain.on(CHANNELS.windowMaximise, () => {
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.on(CHANNELS.windowClose, () => window?.close())
}

// A second instance would fight over the same settings file and window, so hand the
// files to the running one instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  void app.whenReady().then(async () => {
    settings = new SettingsStore(app.getPath("userData"))
    const loaded = await settings.load()

    queue = new JobQueue(
      {
        onChanged: (jobs) => broadcast(EVENTS.jobsChanged, jobs),
        onProgress: (id: string, progress: JobProgress) =>
          broadcast(EVENTS.jobProgress, id, progress),
      },
      join(here, "worker.cjs")
    )
    queue.setConcurrency(loaded.maxConcurrentJobs)

    registerProtocol()
    registerHandlers()
    await createWindow()

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  // Kill in-flight workers rather than orphaning them when the app exits.
  app.on("before-quit", () => queue?.cancelAll())
}
