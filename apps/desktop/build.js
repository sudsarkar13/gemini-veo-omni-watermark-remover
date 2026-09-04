import { build, context } from "esbuild"

/**
 * Bundles the Electron entry points.
 *
 * Electron cannot run TypeScript directly and does not resolve `workspace:*`
 * dependencies at runtime, so main, preload and the worker are each bundled into a
 * single file with the engine and video packages inlined. `electron` itself stays
 * external because it is provided by the runtime, not by node_modules.
 */
const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  // CommonJS throughout. Electron's own module is CJS, so an ESM main process
  // cannot destructure its named exports, and the preload loader rejects ESM
  // outright. Bundling to CJS avoids both interop problems.
  format: "cjs",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
}

const targets = [
  { entryPoints: ["src/main.ts"], outfile: "dist/main.cjs" },
  { entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs" },
  { entryPoints: ["src/worker.ts"], outfile: "dist/worker.cjs" },
]

const watch = process.argv.includes("--watch")

for (const target of targets) {
  const config = { ...shared, ...target }
  if (watch) {
    const ctx = await context(config)
    await ctx.watch()
  } else {
    await build(config)
  }
}

if (watch) process.stdout.write("esbuild watching\n")
