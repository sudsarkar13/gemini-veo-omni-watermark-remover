import { createReadStream } from "node:fs"
import { mkdir, stat, writeFile } from "node:fs/promises"
import { cpus, freemem, tmpdir, totalmem } from "node:os"
import { basename, join, normalize, resolve, sep } from "node:path"
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

import {
  extractFilmstrip,
  extractWaveform,
  probe,
  resolveBinaries,
  type VideoInfo,
} from "@gvowr/video"

import {
  ACCEPTED_EXTENSIONS,
  CHANNELS,
  IMAGE_EXTENSIONS,
  kindOf,
  VIDEO_EXTENSIONS,
  EVENTS,
  type ClipMedia,
  type FilmstripWindow,
  type Job,
  type JobOptions,
  type JobProgress,
  type Settings,
  type StorageUsage,
  type StoredResult,
  type SystemInfo,
} from "@gvowr/ipc"
import {
  MEDIA_SCHEME,
  handleMediaRequest,
  mediaUrl,
  setMediaThumbnails,
  thumbnailUrl,
} from "./media.ts"
import { isFinished, JobQueue } from "./queue.ts"
import { exportPathFor, ResultStore } from "./results.ts"
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
/**
 * Claim our own identity before anything reads a path.
 *
 * Without this the app is called "Electron" and its userData directory is
 * ~/Library/Application Support/Electron — the shared default that every unnamed
 * Electron app uses. Settings would collide with other developers' apps, and, worse,
 * the single-instance lock is shared too: another such app holding it makes this one
 * quit silently at startup with no window and no error.
 *
 * Must run before app.getPath("userData") is called anywhere.
 */
app.setName("Gemini Veo Watermark Remover")

/**
 * The smoke test gets a userData directory of its own.
 *
 * It launches the real app, and the real app takes a single-instance lock. Sharing
 * that lock with whatever the developer happens to have open means the test quits
 * before it can assert anything and fails for a reason that has nothing to do with
 * the code under test — a test that cannot run while you are using the app is a test
 * you learn to ignore. An isolated directory also keeps it from reading or writing
 * real settings.
 */
if (process.env["GVOWR_SMOKE"] === "1") {
  app.setPath("userData", join(tmpdir(), `gvowr-smoke-${process.pid}`))
}

const isDev = !app.isPackaged

/** The static Next.js export. Served over a custom scheme rather than file://. */
const rendererRoot = isDev ? resolve(here, "../../../out") : join(process.resourcesPath, "renderer")

/**
 * When set, the renderer is loaded from the Next dev server instead of the static
 * export. That is what makes hot reload work — editing a component updates the
 * running window rather than requiring a rebuild of the export first.
 *
 * Never set in a packaged build: the app must not depend on a server that is not
 * there.
 */
const devServer = isDev ? process.env["GVOWR_DEV_SERVER"] : undefined

const SCHEME = "app"

// Must be registered before the app is ready. Marking it standard gives the page a
// proper origin, which localStorage and fetch both require.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    // `stream: true` is what allows range requests, and video seeking depends on them.
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

let window: BrowserWindowInstance | null = null
const mediaCache = new Map<string, ClipMedia>()

/**
 * Zoomed filmstrip windows, keyed by job and window.
 *
 * Bounded because each window is a few dozen JPEGs on disk: a long session of
 * scrubbing a long clip would otherwise fill the temp directory one zoom at a time.
 * The files themselves are cleaned up with the rest of the job's thumbnails.
 */
const filmstripCache = new Map<string, FilmstripWindow>()
/** Probe results, so opening a window does not re-probe the file every time. */
const probeCache = new Map<string, VideoInfo>()
const MAX_CACHED_WINDOWS = 12
const MAX_WINDOW_THUMBNAILS = 60
/** Makes each window's filenames unique inside the job's one thumbnail directory. */
let filmstripSequence = 0
let queue: JobQueue
let settings: SettingsStore
let results: ResultStore

/** How often the retention window is applied while the app is running. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

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
    const allowed = url.startsWith(`${SCHEME}://`) || (devServer !== undefined && url.startsWith(devServer))
    if (!allowed) event.preventDefault()
  })

  if (devServer) {
    await window.loadURL(devServer)
    window.webContents.openDevTools({ mode: "detach" })
  } else {
    await window.loadURL(`${SCHEME}://local/index.html`)
  }

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

    // Optionally seed the queue first, so the populated layout can be inspected and
    // not just the empty state.
    const seed = process.env["GVOWR_SMOKE_ADD"]
    if (seed) {
      await queue.add([seed])
      await new Promise((resolve) => setTimeout(resolve, 1200))

      // Exercises the media path from the renderer's side of the bridge: the clip-wide
      // strip and then one zoomed window. Neither can be typechecked into working —
      // they cross the preload bridge, the IPC channel and the media protocol — and
      // both fail silently in the UI, as a filmstrip that simply never appears.
      const media = await window.webContents.executeJavaScript(
        `(async () => {
           const jobs = await window.gvowr.listJobs()
           const id = jobs[0] && jobs[0].id
           if (!id) return "no-job"
           const clip = await window.gvowr.getMedia(id)
           const kind = jobs[0].info ? jobs[0].info.kind : "unprobed"
           const strip = await window.gvowr.getFilmstrip(id, 0, 1, 8)
           // Loading one of them is the point: a URL the protocol cannot resolve looks
           // exactly like a URL it can until the picture fails to arrive. Loaded as an
           // image rather than fetched — the renderer is served from app:// and a
           // cross-scheme fetch is refused by CORS even when the protocol is working.
           let served = "skipped"
           if (strip && strip.thumbnails[0]) {
             served = await new Promise((resolve) => {
               const image = new Image()
               image.onload = () => resolve(image.naturalWidth + "x" + image.naturalHeight)
               image.onerror = () => resolve("failed")
               image.src = strip.thumbnails[0]
             })
           }
           return [
             "kind=" + kind,
             "thumbs=" + (clip ? clip.thumbnails.length : "null"),
             "window=" + (strip ? strip.thumbnails.length : "null"),
             "interval=" + (strip ? strip.interval.toFixed(3) : "null"),
             "served=" + served,
           ].join(" ")
         })()`
      )
      process.stdout.write(`SMOKE media ${media}\n`)
    }

    // Optionally run the job to completion, so the finished screen can be inspected
    // rather than only the ready one. Bounded: a run that never terminates is a
    // failure to report, not a reason to hang the check forever.
    if (seed && process.env["GVOWR_SMOKE_RUN"] === "1") {
      const [job] = queue.list()
      if (job) {
        // Options as JSON, so a check can exercise a path the default run never takes
        // — a hand-drawn region, or the fill.
        let smokeOptions: JobOptions = {}
        const raw = process.env["GVOWR_SMOKE_OPTIONS"]
        if (raw) smokeOptions = JSON.parse(raw) as JobOptions
        queue.start(job.id, smokeOptions)
        const deadline = Date.now() + 180_000
        let final = queue.list()[0]
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          final = queue.list().find((candidate) => candidate.id === job.id)
          if (final && isFinished(final.state)) break
        }
        process.stdout.write(
          `SMOKE run state=${final?.state ?? "gone"} ` +
            `filled=${final?.result?.framesFilled ?? "n/a"} ` +
            `written=${final?.result?.written ?? "n/a"} ` +
            `reason=${final?.result?.reason ?? "none"} ` +
            `corrected=${final?.result?.framesCorrected ?? "n/a"} ` +
            `output=${final?.result?.outputPath ?? "none"}\n`
        )
        // Exercises the export path from the renderer's side of the bridge: preload,
        // channel, store, and the copy-verify-delete order that protects the only
        // copy of somebody's render.
        if (process.env["GVOWR_SMOKE_EXPORT"] === "1") {
          const exported = await window.webContents.executeJavaScript(
            `(async () => {
               const rows = await window.gvowr.listResults()
               if (rows.length === 0) return "no results"
               const updated = await window.gvowr.exportResult(rows[0].id)
               const after = await window.gvowr.listResults()
               const usage = await window.gvowr.storageUsage()
               return [
                 "exportedTo=" + updated.exportedTo,
                 "rowsKept=" + after.length,
                 "stillWaiting=" + after.filter((r) => r.exportedTo === null).length,
                 "usageBytes=" + usage.bytes,
               ].join(" ")
             })()`
          )
          process.stdout.write(`SMOKE export ${exported}\n`)
        }

        // Long enough for the renderer to receive the final snapshot and repaint.
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }

    // Optional screenshot, so the rendered result can be inspected rather than
    // inferred from the fact that nothing threw.
    const shot = process.env["GVOWR_SMOKE_SHOT"]
    if (shot) {
      const image = await window.webContents.capturePage()
      await writeFile(shot, image.toPNG())
      process.stdout.write(`SMOKE shot=${shot}\n`)
    }
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
  protocol.handle(MEDIA_SCHEME, handleMediaRequest)

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
      filters: [
        { name: "Video and images", extensions: [...ACCEPTED_EXTENSIONS] },
        { name: "Video", extensions: [...VIDEO_EXTENSIONS] },
        { name: "Images", extensions: [...IMAGE_EXTENSIONS] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return []
    return queue.add(result.filePaths)
  })

  ipcMain.handle(CHANNELS.jobsAddPaths, (_event, paths: string[]) => queue.add(paths))
  ipcMain.handle(CHANNELS.jobsList, () => queue.list())
  ipcMain.handle(CHANNELS.jobsRemove, (_event, id: string) => queue.remove(id))
  ipcMain.handle(CHANNELS.jobsClearFinished, () => queue.clearFinished())
  ipcMain.handle(CHANNELS.jobsCancel, (_event, id: string) => queue.cancel(id))

  ipcMain.handle(CHANNELS.jobsStart, async (_event, id: string, options: JobOptions = {}) => {
    const current = settings.get()
    // Where the result goes is no longer a run option: it goes to the store, and the
    // user decides where it lands when they export it.
    await queue.start(id, {
      crf: current.crf,
      encoder: current.encoder,
      ...options,
    })
  })

  ipcMain.handle(CHANNELS.jobsReveal, (_event, id: string) => {
    const job = queue.list().find((candidate) => candidate.id === id)
    // Nothing to reveal when nothing was written — a still that found no mark leaves
    // the original alone and produces no file.
    if (job?.result?.outputPath) shell.showItemInFolder(job.result.outputPath)
  })

  /**
   * Builds everything the player and timeline need for one clip.
   *
   * Filmstrip and waveform are extracted on demand and cached per job: they cost a
   * pass over the file, and most clips in a queue are never opened.
   */
  ipcMain.handle(CHANNELS.jobsMedia, async (_event, id: string): Promise<ClipMedia | null> => {
    const job = queue.list().find((candidate) => candidate.id === id)
    if (!job) return null

    const cached = mediaCache.get(id)
    if (cached) {
      return { ...cached, outputUrl: job.result?.written ? mediaUrl(id, "output") : null }
    }

    // A still has no filmstrip and no waveform, and probing it as video would fail on
    // the way to discovering that. It is one picture: the player shows it directly.
    //
    // Decided from the path, not from `job.info`. The renderer asks for media as soon
    // as a job appears, which can be before the probe has landed — and a still that
    // arrives here with `info` still null would go down the video path, cache a
    // filmstrip made from the single picture, and keep showing it for the rest of the
    // session. The extension is known the moment the file is dropped.
    if (kindOf(job.inputPath) === "image") {
      if (!job.info) return null
      const media: ClipMedia = {
        sourceUrl: mediaUrl(id, "source"),
        outputUrl: job.result?.written ? mediaUrl(id, "output") : null,
        thumbnails: [],
        thumbnailInterval: 0,
        waveform: null,
        aspectRatio: job.info.width / job.info.height,
      }
      mediaCache.set(id, media)
      return media
    }

    try {
      const info = job.info ?? (await probe(job.inputPath))
      const directory = join(app.getPath("temp"), "gvowr-thumbs", id)
      const [filmstrip, waveform] = await Promise.all([
        extractFilmstrip(job.inputPath, directory, undefined, { count: 28, width: 160 }),
        extractWaveform(job.inputPath, 400),
      ])
      setMediaThumbnails(id, filmstrip.directory)

      const media: ClipMedia = {
        sourceUrl: mediaUrl(id, "source"),
        outputUrl: job.result?.written ? mediaUrl(id, "output") : null,
        thumbnails: filmstrip.frames.map((frame) => thumbnailUrl(id, basename(frame))),
        thumbnailInterval: filmstrip.interval,
        waveform,
        aspectRatio: info.width / info.height,
      }
      mediaCache.set(id, media)
      return media
    } catch {
      // A clip that cannot be thumbnailed is still playable; degrade rather than fail.
      return {
        sourceUrl: mediaUrl(id, "source"),
        outputUrl: job.result?.written ? mediaUrl(id, "output") : null,
        thumbnails: [],
        thumbnailInterval: 0,
        waveform: null,
        aspectRatio: job.info ? job.info.width / job.info.height : 16 / 9,
      }
    }
  })

  /**
   * A denser strip over one window of the clip, for a zoomed timeline.
   *
   * Windows are cached per job and evicted oldest-first: zooming and scrubbing walks
   * over the same few windows repeatedly, and re-running FFmpeg for a window that is
   * already on disk would make the timeline feel slower the more it is used.
   *
   * Every window lands in the job's existing thumbnail directory under its own file
   * prefix, so the media protocol serves them through the same registry entry and no
   * new path is ever exposed to the renderer.
   */
  ipcMain.handle(
    CHANNELS.jobsFilmstrip,
    async (
      _event,
      id: string,
      fromSeconds: number,
      toSeconds: number,
      count: number
    ): Promise<FilmstripWindow | null> => {
      const job = queue.list().find((candidate) => candidate.id === id)
      if (!job) return null

      const wanted = Math.max(4, Math.min(Math.round(count) || 4, MAX_WINDOW_THUMBNAILS))
      const from = Math.max(0, fromSeconds)
      const span = Math.max(0.02, toSeconds - from)
      const key = `${id}:${from.toFixed(2)}:${span.toFixed(2)}:${wanted}`

      const cached = filmstripCache.get(key)
      if (cached) return cached

      try {
        const directory = join(app.getPath("temp"), "gvowr-thumbs", id)
        let meta = probeCache.get(id)
        if (!meta) {
          meta = await probe(job.inputPath)
          probeCache.set(id, meta)
        }
        const window = await extractFilmstrip(job.inputPath, directory, meta, {
          count: wanted,
          width: 160,
          startSeconds: from,
          durationSeconds: span,
          // The clip-wide strip lives in this directory too, and re-extracting a
          // window must not delete it.
          prefix: `w${filmstripSequence++}`,
          replace: false,
        })
        setMediaThumbnails(id, window.directory)

        const result: FilmstripWindow = {
          thumbnails: window.frames.map((frame) => thumbnailUrl(id, basename(frame))),
          fromSeconds: window.startSeconds,
          toSeconds: window.startSeconds + window.durationSeconds,
          interval: window.interval,
        }

        filmstripCache.set(key, result)
        // Insertion-ordered, so the first key is the oldest.
        for (const stale of [...filmstripCache.keys()].slice(0, filmstripCache.size - MAX_CACHED_WINDOWS)) {
          filmstripCache.delete(stale)
        }
        return result
      } catch {
        // The timeline falls back to stretching the clip-wide strip, which is worse
        // but not wrong. A window that cannot be sampled is not a failed job.
        return null
      }
    }
  )

  ipcMain.handle(CHANNELS.resultsList, (): StoredResult[] => results.list())

  ipcMain.handle(CHANNELS.resultsUsage, (): StorageUsage => ({
    bytes: results.usageBytes(),
    count: results.list().filter((entry) => entry.exportedTo === null).length,
    directory: results.root,
  }))

  ipcMain.handle(CHANNELS.resultsExport, async (_event, id: string): Promise<StoredResult> => {
    const entry = results.find(id)
    if (!entry) throw new Error("that result is no longer in the store")
    const updated = await results.export(id, exportPathFor(entry, settings.get().exportDirectory))
    broadcast(EVENTS.resultsChanged, results.list())
    return updated
  })

  ipcMain.handle(
    CHANNELS.resultsExportAs,
    async (_event, id: string): Promise<StoredResult | null> => {
      const entry = results.find(id)
      if (!entry) throw new Error("that result is no longer in the store")

      const suggested = exportPathFor(entry, settings.get().exportDirectory)
      const chosen = await dialog.showSaveDialog({
        defaultPath: suggested,
        title: "Export result",
      })
      // Cancelling must leave the result exactly where it was, which it does: nothing
      // has been copied or deleted at this point.
      if (chosen.canceled || !chosen.filePath) return null

      const updated = await results.export(id, chosen.filePath)
      broadcast(EVENTS.resultsChanged, results.list())
      return updated
    }
  )

  ipcMain.handle(CHANNELS.resultsRemove, async (_event, id: string) => {
    await results.remove(id)
    broadcast(EVENTS.resultsChanged, results.list())
  })

  ipcMain.handle(CHANNELS.resultsReveal, (_event, id: string) => {
    const entry = results.find(id)
    if (!entry) return
    // The exported file if there is one, otherwise the copy still in the store.
    shell.showItemInFolder(entry.exportedTo ?? entry.storedPath)
  })

  ipcMain.handle(CHANNELS.resultsClear, async () => {
    await results.clear()
    broadcast(EVENTS.resultsChanged, results.list())
  })

  ipcMain.handle(CHANNELS.resultsOpenFolder, async () => {
    // Created on demand: a user asking to see the folder before any run should find
    // one, not an error.
    await mkdir(results.root, { recursive: true })
    await shell.openPath(results.root)
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

    results = new ResultStore(app.getPath("userData"))
    await results.load()
    // At launch and then daily. Anything past the window that was never exported goes,
    // so a machine left alone for a month does not quietly fill up with renders
    // nobody looked at.
    await results.sweep(loaded.retentionDays)
    setInterval(() => {
      void results.sweep(settings.get().retentionDays).then((removed: number) => {
        if (removed > 0) broadcast(EVENTS.resultsChanged, results.list())
      })
    }, SWEEP_INTERVAL_MS)

    queue = new JobQueue(
      {
        onChanged: (jobs) => broadcast(EVENTS.jobsChanged, jobs),
        onProgress: (id: string, progress: JobProgress) =>
          broadcast(EVENTS.jobProgress, id, progress),
        resolveOutput: (job) => results.pathFor(job.id, job.inputPath),
        onCompleted: (job, outputPath) => {
          void results
            .add({
              id: job.id,
              fileName: job.fileName,
              sourcePath: job.inputPath,
              storedPath: outputPath,
              kind: job.info?.kind ?? "video",
              framesCorrected: job.result?.framesCorrected ?? 0,
              framesFilled: job.result?.framesFilled ?? 0,
              framesUncovered: job.result?.framesUncovered ?? 0,
            })
            .then(() => broadcast(EVENTS.resultsChanged, results.list()))
        },
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
