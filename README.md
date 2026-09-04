# Gemini/Veo Omni Watermark Remover

A cross-platform desktop application that removes the **visible** Google Gemini and Veo
watermark from AI-generated video, running entirely on your own machine.

Removal is **exact reverse alpha blending** — the mark is a white logo composited at a
known per-pixel alpha, so it can be mathematically inverted. No blurring, no cropping,
no generated pixels.

> **Scope.** This removes the visible overlay watermark. It does **not** touch SynthID,
> Google's imperceptible watermark, which is a different problem — see
> [`docs/PLAN.md`](docs/PLAN.md) §1.

**Status: in development.** The engine, video pipeline, Electron shell and UI are built
and tested; packaging and signed releases are not done yet.

---

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/engine` | Detection and removal. No I/O, no Electron, no DOM. |
| `packages/video` | FFmpeg sidecar: probe, decode, encode. |
| `packages/ipc` | The contract shared by the shell and the renderer. |
| `apps/desktop` | Electron main process, preload bridge, job queue. |
| `app`, `components`, `hooks`, `lib` | The Next.js renderer. |
| `docs/PLAN.md` | Goals, algorithm, prior art, architecture, build order. |
| `docs/UI-SPEC.md` | Every screen, control and state. |

Built with **Electron** — not Tauri.

## Requirements

- **Node 22.12+** (developed on 26.x). TypeScript runs natively; there is no build step
  for the packages.
- **Yarn 4** — the only supported package manager. Never npm or pnpm.
- **FFmpeg and ffprobe** on `PATH` during development. Packaged builds will ship their
  own sidecar.

```bash
yarn install
```

---

## Testing the app during development

### The full desktop app, with hot reload

```bash
yarn dev:desktop
```

One command. It starts the Next dev server, watches and rebuilds the Electron entry
points, waits for the server to answer, then launches Electron pointed at it.

- **Renderer changes hot-reload.** Edit anything under `app/`, `components/`, `hooks/`
  or `lib/` and the window updates.
- **Main-process changes** (`apps/desktop/src/`) are rebuilt automatically, but Electron
  has to restart to pick them up — press `r` then Enter in the terminal.
- DevTools open automatically in a detached window.
- If a dev server is **already running** (say you have `yarn dev` open in another
  terminal), the script reuses it rather than starting a second one — Next refuses to
  run two dev servers for the same project.
- Launching it twice will not open two windows. The single-instance lock focuses the
  window that is already open.

### The app as users will get it

```bash
yarn build:desktop   # static export + bundled main/preload/worker
yarn start:desktop   # launch it exactly as a packaged build would run
```

Worth doing before believing anything works: this path uses the `app://` protocol and
the static export, not the dev server.

### The engine on its own, with no UI

The engine is the product and the app is a shell around it, so it is testable by itself.
This is the fastest way to check removal quality:

```bash
# Whole video file, end to end
yarn workspace @gvowr/video node src/bin.ts probe clip.mp4
yarn workspace @gvowr/video node src/bin.ts clean clip.mp4 clean.mp4 --size 48

# A single frame, for inspecting detection
yarn workspace @gvowr/engine node src/bin.ts detect frame.ppm
yarn workspace @gvowr/engine node src/bin.ts clean frame.ppm out.ppm --region 1160,600,48,48
```

Both CLIs accept `--json` for machine-readable output, and `--help` lists every flag.

### Tests

```bash
yarn test        # every workspace
yarn typecheck   # every workspace
yarn lint
```

The desktop suite launches the real Electron binary headlessly and asserts the custom
protocol served the renderer and the preload bridge is reachable — checking that the
process merely survives proves neither. The video suite runs against the real FFmpeg
binaries rather than mocks.

You can also capture the running UI:

```bash
cd apps/desktop
GVOWR_SMOKE=1 GVOWR_SMOKE_SHOT=/tmp/ui.png ../../node_modules/.bin/electron .
```

### If Electron will not start

If launching fails with `Cannot read properties of undefined (reading 'isPackaged')`,
check for `ELECTRON_RUN_AS_NODE` in your environment:

```bash
env | grep ELECTRON
```

When it is set, Electron runs as plain Node, `require("electron")` resolves to the npm
wrapper — which exports the binary's *path*, not the API — and every binding is
undefined. `yarn dev:desktop` clears it; a bare `electron .` does not.

---

## Known limitations

- **The watermark template is a synthetic stand-in.** The maths is proven and tested, but
  detection thresholds have not been validated against real captures. See
  `docs/PLAN.md` §9.
- **4K, 1:1 and 9:16 are uncalibrated.** They fall back to a generic estimate of the
  mark's position, and the UI says so rather than hiding it.
- **No frame preview yet.** The IPC contract carries no pixels, so before/after needs a
  separate thumbnail channel.
- **No packaged installers yet.**

## Licence and attribution

This project builds on MIT-licensed prior art. Attribution is required and listed in
[`docs/PLAN.md`](docs/PLAN.md) §10.
