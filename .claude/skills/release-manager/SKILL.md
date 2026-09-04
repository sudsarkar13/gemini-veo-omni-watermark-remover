---
name: release-manager
description: Cut a signed, cross-platform release of the Gemini/Veo Omni Watermark Remover — version bump, changelog, three-platform builds (macOS dmg, Windows nsis, Linux AppImage/deb), checksums, git tag, and GitHub release. Invoke manually when a release is intended; never run automatically as part of ordinary work.
---

# Release Manager

Cuts a release of the Gemini/Veo Omni Watermark Remover desktop app.

> **This skill is manual-invocation only.** It is run when the user explicitly asks for a
> release. Never trigger it as a side effect of other work, and never publish anything
> without the confirmation gate in step 3.

---

## Before doing anything

Read [`docs/PLAN.md`](../../../docs/PLAN.md) and [`AGENTS.md`](../../../AGENTS.md). Two
project rules govern everything below and are easy to violate on autopilot:

1. **No AI attribution anywhere.** Not in commit messages, not in the tag annotation, not
   in the changelog, not in the GitHub release body. No `Co-Authored-By: Claude`, no
   "Generated with Claude Code".
2. **Yarn only.** Never `npm`, `npx`, or `pnpm`. Use `yarn` and `yarn dlx`.

---

## Step 1 — Pre-flight gate

Run every check. **Stop and report if any fails.** Do not "fix and continue" silently —
a release build is not the place to discover a broken test.

```bash
git status --short                  # must be clean
git rev-parse --abbrev-ref HEAD     # confirm the intended branch
yarn install --immutable            # lockfile must be current
yarn explain peer-requirements | grep "✘"   # must return nothing
yarn lint                           # must exit 0
yarn tsc --noEmit                   # must exit 0
yarn test                           # must exit 0
yarn build                          # must succeed
```

Then verify:

- Every package is on its latest stable version, or is recorded as pinned back with a
  real blocker in `docs/PLAN.md` §9.
- `PRIVACY.md` exists and is accurate if any diagnostics feature ships in this version.
- Third-party attribution in the README matches `docs/PLAN.md` §10. This is an MIT
  obligation, not a courtesy.

## Step 2 — Version and changelog

1. Determine the version with the user. Semver. Pre-1.0 releases are `0.x.y`.
2. Bump `version` in the root `package.json` and any workspace package that ships.
3. Generate the changelog from commits since the last tag:

   ```bash
   git log --oneline "$(git describe --tags --abbrev=0)"..HEAD
   ```

   Group under **Added / Changed / Fixed / Known issues**. Write it for users, not for
   developers — "detects watermarks that move mid-clip", not "refactor tracker module".
   Strip gitmoji and Conventional Commit prefixes in the user-facing text.
4. Update `CHANGELOG.md` (create it, Keep a Changelog format, if absent).
5. **Known issues is mandatory, not optional.** If the release has uncalibrated
   resolutions or known failure modes, say so plainly. Honest failure reporting is a
   stated project principle (`AGENTS.md`).

## Step 3 — Confirmation gate

Show the user, and wait for explicit approval before proceeding:

- Version number and the branch being released from
- The full changelog text
- The platforms and artifacts about to be produced
- Whether artifacts will be signed, or shipped unsigned
- Whether this is a pre-release or a full release

**Do not build, tag, or publish before the user confirms.** Tagging and publishing are
outward-facing and hard to reverse.

## Step 4 — Build all three platforms

```bash
yarn build            # renderer (Next.js static export)
yarn dist:mac         # .dmg — universal binary (arm64 + x64)
yarn dist:win         # .exe — NSIS installer
yarn dist:linux       # .AppImage and .deb
```

Notes:

- **Cross-compilation is limited.** macOS artifacts must be built on macOS (signing and
  notarisation require it). If the current machine cannot produce a target, say so and
  let CI handle it — never ship a silently skipped platform.
- Signing:
  - **macOS** — Developer ID, then `notarytool` submit and staple. Verify with
    `spctl -a -vvv -t install <app>`.
  - **Windows** — Authenticode. Verify with `signtool verify /pa`.
  - If credentials are unavailable, build unsigned, **say so explicitly in the release
    notes**, and include the OS-specific instructions users need to open it.
- Confirm the bundled FFmpeg sidecar is present and executable inside each artifact.
  A missing sidecar is the single most likely packaging failure.

## Step 5 — Verify the artifacts

Do not skip this. A release that installs but does not run is worse than no release.

- Install and launch on at least one target; process a short sample clip end to end.
- Check binary sizes are sane — a sudden jump usually means a dev dependency leaked into
  the bundle.
- Generate checksums:

  ```bash
  shasum -a 256 dist/* > dist/SHA256SUMS.txt
  ```

## Step 6 — Tag and publish

```bash
git add -A
git commit -m "🔖 chore(release): v<VERSION>"    # no AI attribution trailer
git tag -a "v<VERSION>" -m "v<VERSION>"          # no AI attribution in the annotation
git push origin HEAD --follow-tags

gh release create "v<VERSION>" \
  --title "v<VERSION>" \
  --notes-file CHANGELOG_ENTRY.md \
  dist/*.dmg dist/*.exe dist/*.AppImage dist/*.deb dist/SHA256SUMS.txt
```

Use `--prerelease` for anything before a stable 1.0 that is not yet broadly tested.

## Step 7 — Post-release

- Verify the release page renders and every artifact downloads.
- Confirm the README install instructions match the artifacts actually published.
- Open a tracking issue for anything listed under Known issues.
- Report to the user: version, artifacts, checksums, and what remains outstanding.

---

## First release (v0.1.0) — extra care

The first public release sets expectations, and this project has claims that must be
exactly right:

- The README must state plainly that this removes the **visible overlay watermark** and
  that **SynthID is out of scope** (`docs/PLAN.md` §1). Never imply otherwise.
- Third-party MIT attribution must be present and correct before the first artifact is
  published.
- If diagnostics ship, `PRIVACY.md` must be accurate and linked from the app.
- List uncalibrated resolutions under Known issues, along with how users can report a
  failing clip. Those reports are the calibration loop (`docs/PLAN.md` §7).
- Prefer shipping v0.1.0 as a **pre-release** so early feedback arrives before the
  version number implies stability.
