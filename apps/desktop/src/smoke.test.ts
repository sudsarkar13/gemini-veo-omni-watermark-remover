import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"

/**
 * Launches the real Electron app headlessly and asserts it actually works.
 *
 * Checking that the process merely survives proves very little. This confirms the
 * custom protocol served the renderer and that the preload bridge is reachable from
 * the page — the two things most likely to break silently when the build layout,
 * protocol handler, or sandbox settings change.
 */

// import.meta.dirname, not __dirname: this file runs directly as an ES module,
// unlike main.ts which is bundled to CommonJS.
const appDirectory = dirname(import.meta.dirname)
const electronBinary = join(appDirectory, "..", "..", "node_modules", ".bin", "electron")

function runSmoke(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    // ELECTRON_RUN_AS_NODE makes Electron behave as plain Node, where `electron` is
    // not a builtin module. Some environments export it; clear it explicitly.
    const env: NodeJS.ProcessEnv = { ...process.env, GVOWR_SMOKE: "1" }
    delete env["ELECTRON_RUN_AS_NODE"]

    const child = spawn(electronBinary, ["."], { cwd: appDirectory, env })
    let output = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      output += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      output += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, output }))
  })
}

describe("desktop app", () => {
  it("boots, serves the renderer, and exposes the preload bridge", async (t) => {
    if (!existsSync(electronBinary)) return t.skip("electron binary not installed")
    if (!existsSync(join(appDirectory, "dist", "main.cjs"))) {
      return t.skip("run `yarn build` in apps/desktop first")
    }
    if (!existsSync(join(appDirectory, "..", "..", "out", "index.html"))) {
      return t.skip("run `yarn build` at the repository root first")
    }

    const { code, output } = await runSmoke()
    assert.match(output, /SMOKE /, `no smoke line in output:\n${output}`)
    assert.match(output, /bridge=object/, `preload bridge was not exposed:\n${output}`)
    assert.doesNotMatch(output, /methods=0/, "bridge was exposed but empty")
    assert.equal(code, 0, `app exited non-zero:\n${output}`)
  })
})
