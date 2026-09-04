import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

/**
 * One command to develop the desktop app.
 *
 * Runs three things together and ties their lifetimes to this process:
 *
 *   1. `next dev`         the renderer, with hot reload
 *   2. esbuild --watch    rebuilds main, preload and worker on change
 *   3. electron           pointed at the dev server rather than the static export
 *
 * Electron is started only once the dev server answers, because a window that loads
 * before the server is up shows a connection error and does not retry.
 *
 * Renderer edits hot-reload. Main-process edits are rebuilt by esbuild but Electron
 * has to be restarted to pick them up — press `r` here to do that without tearing the
 * whole thing down.
 */

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(import.meta.dirname))
const desktopDirectory = join(repoRoot, "apps", "desktop")
const DEV_SERVER = process.env.GVOWR_DEV_SERVER ?? "http://localhost:3000"

/**
 * The `electron` package exports the absolute path to its executable.
 *
 * Resolving it this way rather than reaching for `node_modules/.bin/electron` matters:
 * Yarn hoists Electron to the repository root, so a path relative to the child's
 * working directory does not exist, and the binary's name and location differ by
 * platform anyway.
 */
function electronBinary() {
  const resolved = require("electron")
  if (typeof resolved !== "string" || resolved.length === 0) {
    throw new Error("could not resolve the electron binary; try `yarn install` again")
  }
  return resolved
}

const children = new Set()
let electron = null
let shuttingDown = false

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", cwd: repoRoot, ...options })
  children.add(child)
  child.on("exit", () => children.delete(child))
  // Without this, a failed spawn raises an unhandled 'error' event and takes the whole
  // script down with a stack trace instead of a usable message.
  child.on("error", (error) => {
    process.stderr.write(`\nfailed to start ${command}: ${error.message}\n`)
    shutdown(1)
  })
  return child
}

async function isServerUp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return response.status < 500
  } catch {
    return false
  }
}

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isServerUp(url)) return true
    await delay(400)
  }
  return false
}

function startElectron() {
  // ELECTRON_RUN_AS_NODE makes Electron behave as plain Node, where `electron` is not
  // a builtin module and every API binding comes back undefined. Some shells export
  // it, so clear it explicitly rather than inheriting it.
  const env = { ...process.env, GVOWR_DEV_SERVER: DEV_SERVER }
  delete env.ELECTRON_RUN_AS_NODE

  electron = run(electronBinary(), ["."], { cwd: desktopDirectory, env })
  electron.on("exit", (code) => {
    if (shuttingDown) return
    // A clean exit is usually the window being closed, or the single-instance lock
    // handing off to an app that is already open. Reporting that as a numbered exit
    // reads like a crash.
    const reason = code === 0 ? "electron closed" : `electron exited with code ${code}`
    process.stdout.write(`\n${reason}. Press r to restart, or Ctrl+C to quit.\n`)
  })
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) child.kill("SIGTERM")
  process.exit(code)
}

process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))

// Check the port before starting anything.
//
// Next refuses to run a second dev server for the same project: it moves to another
// port, notices the duplicate, and exits. Meanwhile a naive readiness check sees the
// *existing* server answering and attaches Electron to it — so the window loads, our
// own server is dead, and nothing explains why. Deciding up front avoids that.
const alreadyRunning = await isServerUp(DEV_SERVER)

if (alreadyRunning) {
  process.stdout.write(`reusing the dev server already running at ${DEV_SERVER}\n`)
  process.stdout.write("(started elsewhere, so its output is not shown here)\n")
  run("yarn", ["workspace", "@gvowr/desktop", "run", "dev"])
} else {
  process.stdout.write("starting next dev and esbuild watch…\n")
  run("yarn", ["dev"])
  run("yarn", ["workspace", "@gvowr/desktop", "run", "dev"])

  if (!(await waitForServer(DEV_SERVER))) {
    process.stderr.write(`dev server never became ready at ${DEV_SERVER}\n`)
    shutdown(1)
  }
}

process.stdout.write(`dev server ready at ${DEV_SERVER}, launching electron\n`)
process.stdout.write("press r + enter to restart electron after a main-process change\n")
startElectron()

if (process.stdin.isTTY) {
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (input) => {
    if (input.trim() !== "r") return
    process.stdout.write("restarting electron…\n")
    electron?.kill("SIGTERM")
    setTimeout(startElectron, 300)
  })
}
