# Project Plan — Gemini/Veo Omni Watermark Remover

> **Status:** Planning — no engine code written yet.
> **Last updated:** 2026-09-05
> Companion document: [`UI-SPEC.md`](UI-SPEC.md) — the interface, its controls, and its states.
> This document is the single focus point for the project. Update it as decisions land;
> do not let it drift from the code.

---

## 1. What we are building

A cross-platform **Electron** desktop application that removes the visible Google
Gemini / Veo watermark from AI-generated video, packaged and released for **macOS,
Windows, and Ubuntu/Linux**. Free and open source, with a polished UI.

### Goals

- Mathematically exact removal — no blur, no crop, no hallucinated pixels.
- Detect the watermark **anywhere in the frame**, not just the bottom-right corner.
- **Stills as well as video.** Gemini stamps its images with the same kind of overlay,
  and the engine already works one frame at a time (see [§5](#5-engine-architecture)),
  so a photo is a clip of length one. Refusing to open a PNG would be a limit of the
  shell, not of the tool.
- Batch processing, native hardware decode/encode, no browser file-size ceiling.
- A UI that is pleasant to use, not a debug panel.
- Signed, distributable installers for all three platforms.
- An opt-in diagnostics and feedback loop that turns real-world failures into
  calibration data (see [§7](#7-diagnostics-telemetry--user-feedback)).

### Local-first: why there are no file-size limits

Browser-based competitors cap out around 100-200 MB because WebCodecs holds decoded
frames inside a tab's memory budget and a refresh destroys the work. **We are a native
application with direct filesystem access, so those ceilings do not apply.** Files of
1 GB and beyond process fine; the real limits are disk space for the output and time.

The cost is real, though: full decode -> per-frame detection -> re-encode is CPU-bound
and memory-hungry, and a long 4K clip will saturate cores and hold significant RAM.
The UI must set that expectation **before** a run rather than thirty minutes into one --
pre-flight estimate plus live meters, specified in [`UI-SPEC.md`](UI-SPEC.md) SS6.
No network access is required at any point in processing.

### Non-goals

- **SynthID is explicitly out of scope.** It is Google's imperceptible watermark, and
  it is a different problem. Prior art establishes that there is no reliable public
  detector (a published spectral detector scored ROC AUC 0.20 — worse than random) and
  that the only known "removal" is an SDXL img2img regeneration requiring 4.7–7.3 GB of
  models while visibly degrading the image (29–41 dB PSNR). We remove the **visible
  overlay** and we say so plainly in the README.
- Removing watermarks from non-Google sources (out of scope for v1).

---

## 2. The core algorithm — reverse alpha blending

The Gemini/Veo mark is a pure-white logo composited at a known per-pixel alpha.
That is invertible, so recovery is exact rather than approximated:

```
Gemini applies:  watermarked = alpha * logo + (1 - alpha) * original
We reverse:      original    = (watermarked - alpha * logo) / (1 - alpha)
```

Constants, consistent across every independent implementation studied:

| Constant | Value | Purpose |
| --- | --- | --- |
| `ALPHA_THRESHOLD` | `0.002` | Ignore near-zero alpha (noise) |
| `MAX_ALPHA` | `0.99` | Avoid division by near-zero |
| `LOGO_VALUE` | `255` | The mark is pure white |
| `gain` | `1.0` against the measured template | Intensity tuning multiplier |
| `MIN_RING_SPREAD` | `2` | Floor on the background spread a correction is judged against |

The **alpha map** is a template of the logo captured against black, where
`alpha = luminance / 255`. Prior art derives these templates by **frame-differencing
watermark on/off transition pairs** — high-dynamic-range scenes (lightning flash, light
bulb, sunrise) where the background swings hard while the mark stays fixed, averaged
over 10+ pairs.

**We now have our own capture**, derived without needing transition pairs. The mark is
a constant overlay, so across a clip whose content moves behind it the per-pixel low
percentile is taken where the source was darkest; wherever the source reaches black at
least once, that value *is* `255·α`. Subtracting the black floor measured on the border
inverts `v = b·(1−α) + 255·α` exactly. `scripts/derive-template.mjs` does this, and
`packages/engine/assets/veo-diamond-48.ppm` is the result: 48×48, peak `α ≈ 0.31`,
measured from Veo 720p output. It is the engine's default template.

The synthetic stand-in remains only for fixtures with no provenance. Thresholds tuned
against it were meaningless, which was demonstrated the hard way — see §9.

The only irrecoverable case is a pixel that clipped at 255 under the mark; that
information is genuinely gone.

---

## 3. Prior art — what exists and where it fails

| Project | Licence | Approach | Limitation |
| --- | --- | --- | --- |
| [allenk/GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool) | MIT (full C++ source) | Reverse blend, 3-stage NCC, FDnCNN denoise | Fixed corner ROI; Windows-first; no 4K/1:1/9:16 calibration |
| [allenk/VeoWatermarkRemover](https://github.com/allenk/VeoWatermarkRemover) | Binary-only demo | Video build of the above | No source, unsigned, fixed corner |
| [froggeric/gemini-watermark-and-synthid-remover](https://github.com/froggeric/gemini-watermark-and-synthid-remover) | MIT | Reverse blend + ONNX MI-GAN, CLI | CLI only; fixed corner |
| [ishara-madu/gemini-watermark-remover](https://github.com/ishara-madu/gemini-watermark-remover) | MIT | WebCodecs + mediabunny, browser | Ad popups, CDN runtime dep, fixed corner |
| geminiwatermarkremover.io | Closed | WebCodecs + ONNX | ~100 MB limit, desktop-hardware warning |
| dreamega.ai | Closed | Reverse blend + neural denoise | Chromium-only; free tier is 3 videos |
| logoremover.ai | Closed | Manual brush inpaint | Image-first, vague on video |

### Techniques worth adopting

- **Three-stage fused NCC detection** — `spatial*0.50 + gradient*0.30 + variance*0.20`,
  threshold `0.35`. Polarity-invariant, anchored then widened.
- **Per-shot alpha seed** from ~12 sampled frames so the static mark dominates
  transient content.
- **Per-frame adaptive alpha via bisection** — apply a candidate alpha, then compare
  the region against the surrounding background ring. Brighter than surroundings →
  residue remains → increase. Darker → over-subtracted dark hole → decrease. Up to 5
  rounds, **change capped at ±0.05 between adjacent frames** to prevent visible
  flashing. The goal is visual consistency with local context, not recovery of some
  "true" alpha.
- **Occlusion gate with an honest failure mode** — when foreground motion covers the
  mark, leave the frame untouched rather than inventing pixels.
- **Encode settings** — libx264, CRF 14, preset slow, audio stream-copied untouched.
- **Content-aware denoise sigma** — 50 @ 1080p, 20 @ 720p, ~15 for animation/illustration.

### Known calibration data

- Gemini 3.6 images: 48×48 diamond at every output size, bottom-right.
- Gemini 3.5 images: 36×36 small / 96×96 large.
- Veo 720p variant 1: 48×48 at margin (72, 72) — ~1.5 Mbps tier. *(upstream, not re-measured)*
- Veo 720p variant 2: 44×44 at margin (29, 40) — ~7 Mbps tier. *(upstream, not re-measured)*
- **Veo 720p inset: 48×48 at margin (96, 96)** — measured here, ink at x 1136–1183,
  y 576–623 in a 1280×720 frame. The first placement verified end to end against our
  own capture, and none of the upstream margins match it.
- Four alpha templates exist upstream: `bg_48`, `bg_96` (variant 1) and `bg_b_36`,
  `bg_b_96` (variant 2).

### A useful negative result

allenk shipped an ML alpha-intensity predictor ("Alpha Judge") on-by-default in v0.6.3,
then reverted it to opt-in in v0.6.4 because it over-corrected and made some clips
**worse** than the plain analytical estimate. **Do not lead with ML.** The analytical
path is the product; ML is an opt-in assist.

---

## 4. Our differentiator — the roaming watermark

**Every tool above computes its ROI as `x = width - margin - size` and only ever looks
there.** A mark that appears elsewhere in the frame is invisible to all of them by
construction.

In practice the Gemini/Veo sparkle is *usually* bottom-right, but it can also appear
elsewhere in the frame during a clip. Causes to confirm against samples: Flow's
animated intro sparkle, a watermark baked into a source image that is then animated by
image-to-video, or different placement per surface (Gemini app vs Flow vs Vids) and per
aspect ratio.

Handling this correctly is the primary reason for this project to exist.

### Why full-frame search is normally avoided

Naive multi-scale NCC across a 1080p frame is ~4.7 billion MACs per frame per scale,
and it false-positives on every bright highlight, lens flare, specular sparkle, and
white logo in the actual content.

### How we solve it

**1. Reversibility is the verifier.** A genuine alpha composite can be inverted into
something statistically consistent with its surroundings. Real content cannot. For each
candidate region we solve for the alpha that best blends the patch into its surrounding
ring:

- Some plausible alpha makes the patch indistinguishable from its neighbourhood
  → it was a composite → remove it.
- No alpha works (always too bright, or punches a dark hole) → it is real content
  → leave it alone.

This is prior art's bisection loop repurposed: they use it to *tune* strength at a known
location; we use it to *decide whether a watermark exists at all* at an unknown one.
No existing tool needs this, because none of them look outside the corner.

**2. Temporal persistence kills the remainder.** A lens flare will not hold a coherent
position with a stable alpha across 8+ consecutive frames. A watermark will.

**3. Pyramid search bounds the cost.** Search at 1/4 scale (480×270 for 1080p) with a
downscaled template to find coarse peaks, then refine only the top few peaks at full
resolution — roughly a 16× reduction per level.

---

## 5. Engine architecture

**Two passes over the file: analyse the entire timeline, then render.** Every browser
tool is single-pass streaming and can never use future frames. We can, and that is where
the quality margin comes from.

### Pass 0 — Probe

Decode ~60 frames sampled across the video at quarter resolution. Establish resolution
profile, mark variant and size, the static corner track, scene-cut boundaries, and a
per-shot alpha seed.

### Pass 1 — Detect & track (every frame)

```
for each frame:
  1. predict  -> local +/-8px NCC refine around each active track     (cheap)
  2. sweep    -> full-frame pyramid search, every Nth frame and
                 on every scene cut                                   (bounded)
  3. verify   -> reverse-blend consistency test on candidates         (few)
  4. update   -> extend / spawn / kill tracks
```

### Pass 2 — Consolidate

With the full timeline available: drop tracks that never met the persistence threshold
(false positives), interpolate position and alpha through short occlusions from both
sides, smooth alpha along each track with the ±0.05 per-frame cap, and snap the
persistent corner track to a stable position.

This improves on prior art's occlusion handling: they skip occluded frames entirely,
whereas two-sided interpolation usually recovers them. Only when interpolation
confidence is low do we leave a frame untouched — and the UI reports exactly which
frames were left alone rather than silently passing.

### Pass 3 — Render

Reverse blend per track per frame, optional FDnCNN denoise on touched ROIs only,
re-encode at CRF 14 / preset slow with audio stream-copied.

### Still images — the same engine, one frame

A Gemini image carries the same kind of composited overlay as a Veo clip, so it needs
no new algorithm: detection, reversibility verification and reverse blending all work on
a single frame and already do. What a still changes is everything around the frame.

- **No tracking, and nothing to interpolate.** Persistence, velocity and two-sided
  interpolation all mean "agrees with the frames around it", and there are none. The
  reversibility verifier is therefore the *only* thing standing between a bright patch
  of content and a diamond subtracted out of it — so a still is verified at the
  discovery bar, never the tracking bar.
- **Full-frame sweep is the default**, not an Advanced option. On video a sweep every
  frame is unaffordable; on one frame it costs about half a second. There is no reason
  to look only in the corner.
- **Failure means the file is not written.** A video with five bad frames is still worth
  producing, with those frames reported. An image with one bad frame is a bad image, so
  when nothing verifies, nothing is written and the UI says why.
- **I/O is FFmpeg, as everywhere else.** No image library is added: FFmpeg already
  decodes and encodes PNG, JPEG and WebP, and adding `sharp` would mean a native binary
  per platform for something the existing sidecar does.
- **Alpha is carried through untouched.** A PNG's transparency is decoded alongside the
  colour, held aside during the blend, and re-attached on write. Reverse blending is
  defined on the colour channels; the alpha channel is not ours to touch.
- **Lossless in, lossless out.** PNG is written as PNG and WebP as lossless WebP. A JPEG
  cannot be edited without re-encoding the whole image, so it is written back at the
  highest quality the encoder offers and the UI says plainly that the file was
  re-encoded. Metadata is copied where FFmpeg can carry it.

Image marks are also a different size from Veo's — 48×48 at every output size for Gemini
3.6, 36×36 and 96×96 for 3.5 (see [§3](#known-calibration-data)) — and none of those
margins have been measured here. The sweep finds the mark without a margin; the profiles
are an optimisation we have not earned yet on stills.

### Core data model

The output of detection is **not a rectangle**. It is a set of tracks, which is what
lets us represent a mark that fades in mid-scene, drifts, and vanishes:

```ts
interface WatermarkTrack {
  id: string;
  variant: MarkVariant;          // which alpha template
  frames: Map<number, {
    rect: Rect;                  // position + size at this frame
    alpha: number;               // per-frame tuned intensity
    confidence: number;          // fused NCC score
    state: 'detected' | 'interpolated' | 'occluded';
  }>;
  firstFrame: number;
  lastFrame: number;
}
```

---

## 6. Technology decisions

| Area | Decision | Rationale |
| --- | --- | --- |
| Package manager | **Yarn 4** (`packageManager: yarn@4.18.0`) | Project rule. Never npm/pnpm. Peer conflicts get fixed, not forced. |
| Shell | **Electron** | Cross-platform requirement. |
| Renderer | **Next.js 16 static export** (`output: 'export'`) over a custom protocol | No localhost server in the packaged app; smaller attack surface; simpler signing. All work is local. |
| UI | React 19 + Tailwind 4 + shadcn/ui | Already scaffolded in the repo. |
| Engine | **TypeScript**, ported from MIT C++ with attribution | The ROI is only 48×48–96×96 px, so per-pixel cost is trivial (~50M ops for a 60s 1080p30 clip). The entire cost is decode/encode. Avoiding a C++ toolchain (OpenCV + NCNN + vcpkg across three OSes) removes the single biggest packaging risk. |
| NCC kernel | Isolated behind an interface from day one | Swappable to WASM/SIMD later without touching the tracker. |
| Video I/O | **FFmpeg static sidecar** — raw frame pipe, `-c:a copy` | Decode/encode only. Never used for removal. |
| Denoise | **onnxruntime-node + FDnCNN**, optional | Replaces prior art's NCNN/Vulkan dependency. |
| Diagnostics | **Local structured JSONL** + Electron `crashReporter`; opt-in reporting | No third-party analytics SDK. A privacy tool cannot ship a background beacon. |
| Report transport | **Prefilled GitHub issue** by default; opt-in direct endpoint | Zero infrastructure, user's own account, nothing held by us. |
| Dependency currency | **Latest stable of everything**, verified against peer ranges | No outdated packages. Every upgrade must keep `yarn explain peer-requirements` at zero failures - see SS9 for what is currently pinned back and why. |
| Packaging | **electron-builder** — dmg / NSIS / AppImage + deb | Standard three-target output. |

---

## 7. Diagnostics, telemetry & user feedback

### The constraint that shapes this entire section

**This is a privacy tool.** Every competitor's headline claim is "your video never leaves
your device," and ours will be too. Telemetry that quietly undermines that promise would
destroy the product's credibility faster than any missing feature. So the rules are
absolute:

- **Off by default.** No collection and no network call until the user opts in.
- **Nothing leaves the machine unseen.** Every report is rendered in full, in plain
  language, in a review dialog the user can edit before sending.
- **Video content is never transmitted automatically** — not the file, not frames, not
  audio.
- **No third-party analytics SDK**, no marketing pixel, no background beacon.

### Why we want it anyway — this is a calibration loop, not vanity metrics

Our hardest engineering problem is that we cannot enumerate every watermark variant,
resolution profile, and roaming behaviour Google ships. Upstream projects carry an open
"Help Wanted: Other Resolutions" request for exactly this reason.

**The failures users hit are our missing calibration data.** A structured report from a
clip we handled badly tells us the resolution profile, the NCC scores, the alpha we
settled on, and which frames we gave up on — precisely what is needed to add a new
profile. This is the mechanism by which the detector improves after release, and it is
the reason telemetry earns its place in a tool that otherwise touches no network.

### Three tiers, escalating consent

**Tier 1 — Local diagnostic log. Always on, never transmitted.**
Rotating structured JSONL in the app's `userData` directory. Viewable in-app with an
"Open log folder" action. This costs the user nothing and breaks no promise, and it means
that when someone *does* want to report a problem, the evidence already exists instead of
requiring them to reproduce it.

**Tier 2 — User-initiated report. Explicit and reviewed.**
After a job completes, the UI asks one lightweight, dismissible question: *did this look
right?* A thumbs-down opens the report composer pre-filled with the diagnostic bundle —
fully visible, fully editable — plus a free-text field for what went wrong. Actions are
**Export to file**, **Copy**, and **Send**. The prompt itself can be turned off
permanently in Settings.

**Tier 3 — Sample attachment. Separately consented, per report, never pre-checked.**
Optionally attach the watermark **ROI crop** — a ~96x96 px patch, not the frame and not
the video — for the frames the engine flagged. This is simultaneously the most valuable
calibration artifact we could receive and among the least sensitive things we could ask
for. A thumbnail preview of exactly what would be attached is shown before sending.

### What a report contains

| Field | Example | Why |
| --- | --- | --- |
| App version, build, channel | `0.2.0 / darwin-arm64 / stable` | Regression scoping |
| OS, arch, CPU/GPU, RAM | `macOS 15.6, M3, 24 GB` | Encoder path selection |
| Video metadata | `1080x1920, h264, 30 fps, 8.2 s, 7.1 Mbps` | Resolution profile — **not** content |
| Engine plan | Variant, template, per-track rect + alpha + NCC scores | **The calibration payload** |
| Outcome counters | Frames processed / interpolated / occluded-skipped | Quality signal |
| Stage timings | Probe, detect, render, encode | Performance regressions |
| Error | Message + stack, when one occurred | Triage |
| User note | Free text | What the user actually saw |
| Correlation id | UUID v4, generated per report | Dedupe only — **not** a persistent user id |

### What is never collected

- The video, the audio, or any full frame.
- Absolute paths or filenames. A path is reduced to its extension plus a **locally salted
  hash**; the salt never leaves the machine, so we can tell "the same file was reported
  twice" without ever learning what it is.
- Any persistent device or user identifier, IP-derived location, or account data.
- Clipboard contents, other open files, directory listings, or network configuration.

### Crash reporting

Main, renderer, and worker crashes are captured via Electron's `crashReporter` into the
local log. **Uploading a minidump is a separate opt-in** behind the same review dialog,
because minidumps can contain arbitrary process memory.

### Transport — two paths

This is open source; users must never be forced through infrastructure we control.

1. **GitHub issue — zero infrastructure, the default.** Compose the report as markdown
   and open a prefilled issue. Posted from the user's own account, fully public, nothing
   held by us.
2. **Direct endpoint — opt-in.** POST to our own collector for users without a GitHub
   account. Rate-limited, no auth, no cookies, retention-limited, purpose-limited to
   calibration and bug triage.

Both paths emit the same payload so triage stays uniform.

### Obligations before any of this ships

- **`PRIVACY.md`** in the repo stating exactly the above, linked from both the Settings
  toggle and the report dialog.
- A **Settings > Diagnostics** page with: the opt-in toggles, "view raw log", "open log
  folder", and **"delete all local diagnostics"**.
- Opting out is honoured immediately **and retroactively** — any queued reports are
  deleted, not held.
- Because collection is opt-in, reviewed, and purpose-limited, this sits comfortably
  within GDPR/CCPA expectations. The direct endpoint must not ship until `PRIVACY.md` is
  accurate and the retention window is implemented.

---

## 8. Build order

- [ ] **Phase 1 — Engine core, headless.** Reverse blend, alpha template loading, NCC
      cascade, tracker, reversibility verifier. Ships with a CLI and a fixture corpus.
      *The engine is the product; the app is a shell around it.* No Electron code yet.
- [ ] **Phase 2 — FFmpeg sidecar I/O.** Raw frame pipe in/out, audio passthrough,
      progress reporting, per-platform binary resolution.
- [ ] **Phase 3 — Electron main / preload / IPC.** Worker isolation so the UI never
      blocks on processing.
- [ ] **Phase 4 — UI.** Built to [`UI-SPEC.md`](UI-SPEC.md): two-pane queue + preview,
      track timeline, Advanced drawer, pre-flight estimate and live resource meters.
      *Nothing outside that spec gets built without updating it first.*
- [ ] **Phase 4b — Still images.** Image I/O through the FFmpeg sidecar, the single-frame
      path through the existing engine, queue and UI support for stills alongside clips.
      *No new algorithm — the engine already works one frame at a time.*
- [ ] **Phase 5 — Diagnostics & feedback.** Report composer, review dialog, ROI-crop
      attachment, Settings > Diagnostics page, `PRIVACY.md`, GitHub-issue transport.
      *Tier 1 structured logging is built in Phase 1, not deferred to here* — the
      engine emits the diagnostic record as a first-class output, not an afterthought.
- [ ] **Phase 6 — Packaging & signing.** macOS notarisation, Windows signing, Linux
      AppImage/deb. CI release workflow.

---

## 9. Open items

### Decisions still to be made

- Code signing: Apple Developer ID and Windows certificate available, or do first
  releases ship unsigned with install instructions?
- Telemetry transport: ship the direct collector endpoint in v1, or GitHub-issue only
  until there is real demand? (GitHub-only is the lower-risk start — no infrastructure,
  no retention obligations, no `PRIVACY.md` endpoint claims to keep accurate.)
- Retention window for the direct endpoint, if we build it.

### Dependency versions currently pinned back

Policy is latest stable everywhere. Two packages cannot move yet, both blocked by real
peer conflicts rather than caution. Re-check both when `eslint-config-next` updates:

| Package | On | Latest | Blocker |
| --- | --- | --- | --- |
| `eslint` | 9.39.5 | 10.10.0 | `eslint-plugin-react@7.37.5`, pulled in by `eslint-config-next`, caps at `^9.7`. Combined range across 15 consumers resolves to `^9.7.0`. |
| `typescript` | 5.9.3 | 7.0.2 | `typescript-eslint@8.69.0` requires `>=4.8.4 <6.1.0`. TypeScript 6 is beta-only, so 5.9.3 is the newest stable that satisfies it. |

### Calibration inputs needed

The detector can be built without these, but thresholds and priors must be set against
ground truth rather than guesses:

- Sample clips where the mark appears **away from the bottom-right corner**.
- Samples at **9:16**, **1:1**, and **4K** — resolutions upstream explicitly has no
  calibration for, and 9:16 covers most real Veo output.
- ~~Watermark on/off transition pairs, for deriving our own alpha templates.~~ Not
  needed: `scripts/derive-template.mjs` recovers the alpha from any single clip whose
  background goes dark under the mark (§2).

### Alpha template provenance

`packages/engine/assets/veo-diamond-48.ppm` is our own measurement and is the default.
The upstream MIT templates remain available with attribution for variants we have not
captured. Every new resolution needs its own measurement, not arithmetic from this one.

### What the first real clip changed

Running against real Veo footage rather than fixtures invalidated four things at once,
and it is worth recording why each survived so long:

1. **The template was a synthetic stand-in.** Detection scored 0.44 against a mark it
   now scores 0.79 on. Nothing downstream could work reliably.
2. **The verifier rejected the genuine mark.** Against black sky the background ring's
   standard deviation is ~0.5, so a correction accurate to 0.86 of one 8-bit level
   scored 1.6σ and failed a 0.6σ test. Fixed by flooring the spread at the encoder's
   noise (`MIN_RING_SPREAD`).
3. **The bisection reported failures as successes.** Where no intensity reconciled a
   patch, the search walked to its ceiling and the endpoint was returned as "the gain
   that worked" — subtracting diamond-shaped holes out of real content. A candidate
   whose residual never changes sign is now rejected outright.
4. **The fixtures were unrealistic.** ±32 levels of uncorrelated noise, roughly six
   times a real H.264 encode, which depressed every score and made a 0.35 detection
   threshold look reasonable. At realistic noise a genuine mark scores 0.78.

The lesson is the one already written into `templates.ts`: a threshold tuned against a
stand-in means nothing. Detection now uses a separate, much higher bar to *start* a
track from a full-frame sweep (`DEFAULT_DISCOVERY_THRESHOLD`) than to keep following
one, because those two decisions carry very different costs.

That higher bar then caused a fault of its own. Following was seeded from the previous
frame's observations, so one frame the verifier declined erased the tracker's memory
and the mark could only return through a sweep — at the discovery bar, which busy
footage does not reach. Sixteen frames kept their watermark as a result. A place the
mark has just been is a prior, so locations now stay searchable for a bounded window
after their last sighting (`reacquireFrames`).

### How removal quality is measured

Two obvious metrics are both wrong, and each sent this project chasing a phantom:

- **Brightness against a surrounding ring.** Content moving through the region moves
  the ring, so the number reflects the footage rather than the residue.
- **Correlation with the mark's shape.** Scale-free, so against a near-black
  background a residue of one level scores as high as a visible mark.

What works is the **least-squares amplitude of the template shape in the region**,
reported in 8-bit levels, **measured alongside unmarked control regions of the same
clip**. Ordinary content correlates with a diamond too; without controls there is no
separating what we left behind from what was always there. On the calibration clip:

| Region | Source | Cleaned |
| --- | --- | --- |
| The mark | 235.1 | 12.9 |
| Control, 160 px left | 36.4 | 36.4 |
| Control, 160 px up | 20.9 | 20.9 |
| Control, diagonal | 28.8 | 28.8 |

The mark's site ends up quieter than ordinary content, and the controls are unchanged
to one decimal place — nothing outside the mark was touched.

**Per-frame alpha was left alone deliberately.** The estimate is 1.002 on
well-conditioned frames and wanders 0.75–1.22 on busy ones, which looks like a case
for a single clip-wide value. Measured against a confidence-weighted median, it
improves the median residual (3.6 → 2.9) and worsens the tail (p95 50 → 60). Not a
win, so the per-frame estimate with `ALPHA_STEP_CAP` stays. Recorded here so the idea
is not re-proposed as though untested.

---

## 10. Attribution

This project builds on techniques from MIT-licensed prior art. Attribution is required
and must appear in the README and in source headers where code is ported:

- **[allenk/GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool)** — MIT,
  © AllenK (Kwyshell). Reference implementation of reverse alpha blending, three-stage
  NCC detection, and the adaptive bisection loop. Also the source of the alpha templates.
- **[froggeric/gemini-watermark-and-synthid-remover](https://github.com/froggeric/gemini-watermark-and-synthid-remover)** —
  MIT, © Frédéric Guigand. Cross-platform pipeline design and MI-GAN inpainting approach.
- **[ishara-madu/gemini-watermark-remover](https://github.com/ishara-madu/gemini-watermark-remover)** —
  MIT, © Ishara Madushanka. Browser WebCodecs pipeline reference.
- Background reading: [Removing Gemini AI Watermarks: A Deep Dive into Reverse Alpha Blending](https://allenkuo.medium.com/removing-gemini-ai-watermarks-a-deep-dive-into-reverse-alpha-blending-bbbd83af2a3f)
