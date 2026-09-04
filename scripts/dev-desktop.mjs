import { spawn } from "node:child_process"
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

const DEV_SERVER = process.env.GVOWR_DEV_SERVER ?? "http://localhost:3000"
const children = new Set()
let electron = null
let shuttingDown = false

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", shell: false, ...options })
  children.add(child)
  child.on("exit", () => children.delete(child))
  return child
}

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok || response.status < 500) return true
    } catch {
      // Not up yet.
    }
    await delay(400)
  }
  return false
}

function startElectron() {
  // ELECTRON_RUN_AS_NODE makes Electron behave as plain Node, where `electron` is not
  // a builtin module and the app cannot start. Some shells export it; clear it.
  const env = { ...process.env, GVOWR_DEV_SERVER: DEV_SERVER }
  delete env.ELECTRON_RUN_AS_NODE

  electron = run(process.platform === "win32" ? "npx.cmd" : "./node_modules/.bin/electron", ["."], {
    cwd: "apps/desktop",
    env,
  })
  electron.on("exit", (code) => {
    if (!shuttingDown) {
      process.stdout.write(`\nelectron exited (${code}). Press r to restart, or Ctrl+C to quit.\n`)
    }
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

process.stdout.write("starting next dev and esbuild watch…\n")
run("yarn", ["dev"])
run("yarn", ["workspace", "@gvowr/desktop", "run", "dev"])

if (!(await waitForServer(DEV_SERVER))) {
  process.stderr.write(`dev server never became ready at ${DEV_SERVER}\n`)
  shutdown(1)
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
