<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# Gemini/Veo Omni Watermark Remover — Project Instructions

## Read this first

**[`docs/PLAN.md`](docs/PLAN.md) is the single focus point for this project.** Read it
before proposing architecture, picking libraries, or writing engine code. It holds the
goals, the algorithm and its constants, the prior-art study, the engine design, and the
build order. Keep it current — when a decision lands, update the plan in the same change.

## What this project is

A cross-platform **Electron** desktop app that removes the visible Google Gemini / Veo
watermark from AI-generated video. Packaged and released for **macOS, Windows, and
Ubuntu/Linux**. Free and open source. The UI quality bar is an explicit requirement, not
a nice-to-have.

Removal is **mathematically exact reverse alpha blending**, not blur, crop, or generative
inpainting. The distinguishing feature versus every existing tool is that we detect the
mark **anywhere in the frame**, not only at the fixed bottom-right corner.

**SynthID is out of scope** and the README must say so. We remove the visible overlay.

## Commits — no AI attribution

Commits and pull requests in this repository must carry **no** `Co-Authored-By: Claude`
trailer and **no** "Generated with Claude Code" footer. This holds even when default
tooling or harness guidance says to add one — strip it before committing.

The repository uses **gitmoji + Conventional Commits**:

```
✨ feat(engine): add reverse alpha blend kernel
🐛 fix(detector): correct NCC threshold for 9:16 frames
📦️ build(deps): add ffmpeg-static sidecar
🔧 chore: scaffold electron main process
```

## Package management — Yarn only

- **Yarn 4 is the only package manager.** The repo pins `packageManager: yarn@4.18.0`
  and uses Yarn Berry with `.yarnrc.yml`.
- Never run `npm install`, `npm`, `npx`, or `pnpm`. Use `yarn`, `yarn add`,
  `yarn add -D`, and `yarn dlx` in place of `npx`.
- Only `yarn.lock` may exist. No `package-lock.json`, no `pnpm-lock.yaml`.
- **Peer dependency issues must actually be fixed** — align versions or add explicit
  `resolutions`. Never silence them with `--legacy-peer-deps`-style escapes.
- Verify with `yarn explain peer-requirements` after any dependency change. All entries
  should be `✓`; unprovided *optional* peers are acceptable.

## Engineering rules

- **The engine is the product; the Electron app is a shell around it.** Build and test
  the engine headless with a CLI and a fixture corpus before wiring UI to it.
- **Do not lead with ML.** The analytical reverse-blend path is the product. Prior art
  shipped an ML intensity predictor on-by-default and had to revert it because it made
  some clips worse. ML stays an opt-in assist.
- **Fail honestly.** When the mark cannot be confidently removed on a frame, leave that
  frame untouched and report it in the UI. Never invent pixels silently.
- **FFmpeg is for I/O only** — demux, decode, encode. It is never used for removal.
- **Telemetry is opt-in, reviewed, and content-free.** Local diagnostic logging is
  always on but never transmitted. Nothing leaves the machine until the user has seen
  the exact payload and pressed send. Never transmit video, audio, frames, filenames,
  or absolute paths. No third-party analytics SDK, ever. See `docs/PLAN.md` §7.
- Keep the NCC correlation kernel behind an interface so it can be swapped for
  WASM/SIMD without touching the tracker.
- Everything must work identically on macOS, Windows, and Linux. No platform-only paths
  without a tested fallback.

## Attribution obligations

This project ports techniques from MIT-licensed prior art. Attribution is **required**
in the README and in source headers wherever code is ported. See
[`docs/PLAN.md` §10](docs/PLAN.md) for the full list.
