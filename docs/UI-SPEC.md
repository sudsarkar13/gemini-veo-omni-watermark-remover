# UI Specification — Gemini/Veo Omni Watermark Remover

> **Status:** Approved direction, not yet built.
> **Last updated:** 2026-09-05
> Companion to [`PLAN.md`](PLAN.md). That document defines *what the engine does*; this
> one defines *what the user sees and can do*.

---

## 0. Why this document exists

**This spec is a contract against bloat.** Every control, action, and state in the
application is enumerated here. If a feature is not in this document, it does not get
built until this document is updated to include it and something justifies its place.

The failure mode we are avoiding is the one visible in every competing tool: a pile of
sliders accreted one bug report at a time, until the app is a control panel rather than a
product. Adding a control here should feel expensive.

---

## 1. Approved design direction

Four decisions are locked. Everything below follows from them.

| Decision | Choice |
| --- | --- |
| **Visual direction** | Pro media tool, **dark-first**. Dense, calm, dark neutral surfaces, one accent colour. Light theme supported; dark is the default. |
| **Layout** | **Two-pane** — persistent queue sidebar, preview + track timeline on the right. |
| **Control depth** | **Simple by default, Advanced drawer.** One obvious path; power hidden but reachable. |
| **Resource warnings** | **Pre-flight estimate + live meters.** Predict before running, show truth during. |

### Design principles

1. **The frame is the hero.** Our chrome is dark and recessive so the user's video is the
   brightest thing on screen. No decorative gradients competing with content.
2. **Calm, not exciting.** This is a utility people run on their own footage. Motion is
   functional (progress, state transitions), never ornamental.
3. **Honest state.** Never show a spinner where we could show a number. Never imply
   success on frames we skipped. If we gave up on 4 frames, the UI says so.
4. **One obvious path.** A first-time user should succeed without opening anything.
5. **Dense where it earns it.** The queue and timeline are information-rich; the drop zone
   and empty states are spacious. Density follows purpose, not a global setting.

---

## 2. Visual language

Built on the existing **shadcn/ui + Tailwind 4** scaffold. Tokens are defined in
`app/globals.css` as CSS custom properties so the theme swap is a token swap, never a
component rewrite.

### Colour

| Token | Role |
| --- | --- |
| `--background` | App ground. Near-black neutral, not pure `#000` (pure black crushes against video letterboxing). |
| `--surface` | Panels: sidebar, drawer, cards. One step lighter than ground. |
| `--surface-raised` | Popovers, dialogs, tooltips. |
| `--border` | Hairlines. Low contrast; structure comes from surface steps, not heavy rules. |
| `--foreground` / `--muted-foreground` | Primary and secondary text. |
| `--accent` | Single accent. Primary actions, active track lane, focus ring. |
| `--success` / `--warning` / `--danger` | Job done / resource pressure / failure. |
| `--track-corner` / `--track-roaming` / `--track-occluded` | Timeline lane identity — see §5.3. |

Semantic colour is **never** the only signal. Every status pairs colour with an icon and
a text label, for colour-blind users and for screenshots in bug reports.

### Typography

- **UI:** the app's existing sans stack. 13px base — this is a desktop tool, not a
  webpage.
- **Numeric:** tabular figures (`font-variant-numeric: tabular-nums`) everywhere numbers
  change in place — timecodes, percentages, resource meters, frame counts. Without this,
  progress readouts jitter.
- **Monospace:** file paths, codec strings, diagnostic output, region coordinates.

### Motion

- Transitions 120–180 ms, ease-out. Anything slower feels laggy in a desktop app.
- Progress bars animate value changes; they never animate indeterminately if a real
  number is available.
- Respect `prefers-reduced-motion`: cross-fades collapse to instant swaps.

---

## 3. Window anatomy

```
┌──────────────────────────────────────────────────────────────────────┐
│  ⌂  Gemini/Veo Watermark Remover              [⚙ Settings]  [– □ ×]  │  Title bar
├──────────────┬───────────────────────────────────────────────────────┤
│  QUEUE       │   ┌───────────────────────────────────────────────┐   │
│              │   │                                               │   │
│ ▸ clip1.mp4  │   │        before   │   after                     │   │  Preview
│   ✓ done     │   │           (split scrubber)                    │   │  canvas
│              │   │                                               │   │
│ ▸ clip2.mp4  │   └───────────────────────────────────────────────┘   │
│   ▓▓▓░░ 72%  │   ┌───────────────────────────────────────────────┐   │
│              │   │ 0s    2s    4s    6s    8s    10s             │   │  Track
│ ▸ clip3.mp4  │   │ ┃▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓┃  corner           │   │  timeline
│   queued     │   │ ┃      ▓▓▓▓▓▓▓            ┃  roaming          │   │
│              │   │ ┃  ✕            ✕         ┃  occluded         │   │
│ ─────────────│   └───────────────────────────────────────────────┘   │
│ + Add files  │   ▸ Advanced                                          │  Drawer
│              │   ┌───────────────────────────────────────────────┐   │  (collapsed)
│              │   │ ⚡ Est. 2m 10s · ~1.8 GB peak RAM · 340 MB disk│   │  Pre-flight
│              │   └───────────────────────────────────────────────┘   │
│              │                              [ Cancel ]  [ Run ▶ ]    │  Action bar
└──────────────┴───────────────────────────────────────────────────────┘
```

- **Minimum window:** 1024 × 680. Below that the sidebar collapses to icons-only.
- **Sidebar:** 260 px default, drag-resizable 200–400 px, width persisted.
- **Preview / timeline split:** drag-resizable, persisted. Timeline has a minimum height
  of 3 lanes and collapses to a single summary strip below that.
- **Frameless window with custom title bar** on all platforms, with native traffic
  lights on macOS and native controls on Windows/Linux. Draggable region excludes all
  interactive controls.

---

## 4. Surfaces

| Surface | Type | Purpose |
| --- | --- | --- |
| Main window | Persistent | Everything below except Settings and dialogs. |
| Empty state | Replaces both panes | First run and empty queue — large drop target. |
| Settings | Modal, tabbed | General, Processing, Diagnostics, About. |
| Report composer | Modal | Feedback / issue reporting (`PLAN.md` §7). |
| Pre-flight sheet | Inline card | Resource estimate before a run. |
| Confirm dialogs | Modal | Destructive or expensive actions only. |
| Toast | Transient, bottom-right | Job completion, export finished, copy confirmations. |

---

## 5. Panels and controls

Every control the application ships. Nothing outside this list gets built.

### 5.1 Queue sidebar

| Control | Type | Behaviour |
| --- | --- | --- |
| Add files | Button + drop target | Native file picker, multi-select. Accepts video `.mp4 .mov .mkv .webm` and stills `.png .jpg .jpeg .webp` — see §5.7. |
| Job row | List item | Thumbnail, filename (truncated middle, full path on hover), resolution, duration, status. |
| Row status | Icon + label | `queued` · `analysing` · `processing %` · `done` · `skipped frames` · `failed`. |
| Row context menu | Right-click | Reveal in Finder/Explorer · Remove from queue · Retry · Copy diagnostics. |
| Reorder | Drag | Reorder pending jobs. Running and finished jobs are not draggable. |
| Clear finished | Button | Removes completed rows. Never removes queued or running. |
| Run all / Pause all | Button | Batch transport. Pause finishes the current frame, never mid-write. |

Selecting a row drives the right pane. Multi-select is supported for remove and retry
only — never for editing region or alpha, which are per-clip by nature.

### 5.2 Preview canvas

| Control | Type | Default | Behaviour |
| --- | --- | --- | --- |
| Compare mode | Segmented | Split | `Split` (draggable divider) · `Side-by-side` · `Before` · `After` · `Difference` (amplified delta — the honest way to inspect residue). |
| Zoom | Slider + buttons | Fit | Fit · 100% · up to 800%, as a percentage of source pixels rather than of the pane. Scroll-wheel zooms at the cursor. Above 100% the picture is drawn nearest-neighbour: an interpolated pixel is an invented one, and this view exists to judge pixels. Both halves of a comparison carry the identical transform, so they stay registered at any magnification. |
| Pan | Drag | — | Middle-drag always; left-drag when zoomed, except in Split (where it moves the divider) and Mark (where it draws). Space is play/pause and is not a pan modifier. |
| Mark region | Drag on the canvas | — | Draws a box over a watermark the detector missed. Enters **Mark** mode; the pointer draws instead of panning. See §5.6. |
| Loupe | Toggle | Off | Magnified inset locked to the active watermark region — the fastest way to judge removal quality. |
| Frame step | Buttons + `,` / `.` | — | Previous / next frame. |
| Playback | Button + `Space` | — | Play the processed result in place. |

### 5.3 Track timeline

The visual expression of the `WatermarkTrack` model in `PLAN.md` §5. This is the part of
the UI no competing tool has, because no competing tool models more than one fixed
rectangle.

- **One lane per detected track.** Lane label shows the mark variant and whether it is the
  persistent corner mark or a roaming one.
- **Segment fill encodes state:** solid = detected, hatched = interpolated,
  `✕` marker = occluded and deliberately left untouched.
- **Confidence** renders as segment opacity, so weak detections are visibly weak.
- Clicking a segment seeks the preview to that frame and selects the track.
- Hovering shows a tooltip: frame number, timecode, region `x,y,w,h`, alpha, NCC score.
- **Occluded ranges are always visible and never silently hidden** — principle 3.
- **Frames no track reached at all** are drawn distinctly from occluded ones. A frame
  the engine decided to leave is not the same as one it never considered, and only the
  second means the output still carries the mark.
- **Zoom** (`+` / `−` while the timeline is focused, scroll-wheel, or the buttons in the
  timeline header) shows a window of the clip rather than the whole of it, so individual
  frames can be reached on a long clip. The filmstrip genuinely resolves as it zooms —
  the main process samples the visible window itself, down to one thumbnail per frame —
  rather than stretching the clip-wide strip. The playhead stays centred, so the window
  follows playback instead of jumping a screen at a time. Fit-to-clip is always one press
  away.
- Once zoomed, the header names the window in **frames**, not timecode: a window under a
  second reads as "0:09–0:09" in timecode, and frames are what a run reports its gaps in,
  so "frames 227–239" lines up directly against "frames 235–239 still carry the mark".

### 5.6 Marking a watermark by hand

Auto-detection is deliberately reluctant. Admitting a mark nobody asked about means
altering pixels on one frame's evidence, so the bar is high — and a roaming mark that
is small, faint, or on screen for a handful of frames will sometimes fall under it.
Rather than lower the bar for everyone, the user can say where the mark is.

| Control | Type | Behaviour |
| --- | --- | --- |
| Mark mode | Toggle (`M`) | While on, dragging on the preview draws a region instead of panning. |
| Draw region | Drag | Creates a region at the current frame. Snaps to a square, since the mark is one. |
| Region list | List | One row per region: thumbnail of the drawn area, frame range, size. |
| Frame range | Two numeric fields + drag on timeline | Inclusive. Defaults to the current frame through the end of the clip. |
| Nudge / resize | Arrow keys, handles | Selected region only. |
| Delete region | `⌫` or row button | |

**A drawn region is a prior, not an instruction.** It seeds the search where the user
says the mark is; the engine still settles the exact position and still measures the
alpha by reversibility before removing anything. A box drawn over something that is
not an alpha composite removes nothing, and the run reports those frames as
uncovered rather than inventing a correction — the same contract as everywhere else.

**A region only has to be right where it is drawn.** The observation it produces
enters the tracker like any other, so a mark that moves is followed from there.

Regions persist with the job so a re-run keeps them, and are listed in the diagnostics
report as counts and rectangles — never as pixels.

### 5.7 Still images

Gemini stamps its images with the same kind of overlay it stamps on video, and the
engine works one frame at a time regardless — so a photo is a clip of length one and
goes in the same queue, alongside clips, in any mix.

The screen is the one already specified, with the parts that mean nothing for a still
absent rather than disabled:

| Element | With a still |
| --- | --- |
| Preview canvas | Unchanged. Split · Side-by-side · Before · After all work, and zoom matters *more* here — an image is usually larger than the pane. |
| Transport (play, frame step, timecode) | Absent. There is nothing to play and one frame to step through. |
| Track timeline | Absent. It is a picture of time. |
| Mark mode | Unchanged, minus the frame range: a region drawn on a still applies to the still. |
| Advanced drawer | Detection mode, alpha, mark variant and manual region apply. Video-only rows — sweep interval, denoise, codec, CRF, encoder — are hidden. |
| Pre-flight estimate | A line rather than a card. Measured: about 3 s at 1280×720, 13 s at 4K — nearly all of it the full-frame sweep. |
| Header metadata | `1920×1080 · PNG · 2.4 MB · alpha` in place of the clip's codec and duration line. |

**Detection runs as a full-frame sweep by default**, because on one frame it costs
almost nothing and there is no reason to look only in the corner. It is verified at the
discovery bar rather than the tracking bar: with no neighbouring frames to agree with,
reversibility is the only evidence there is.

**When nothing verifies, no file is written.** A clip with five bad frames is still worth
producing with those frames reported; an image with one bad frame is a bad image. The UI
says the mark was not found, or was found and could not be inverted, and leaves the
original alone.

**A format this build of FFmpeg cannot write is refused before the run starts**, naming
the missing encoder, rather than after the work is done. The format is never quietly
substituted: handing back a PNG named `.webp` would be a liberty taken with someone's
file.

**The output format follows the input**, and the UI is explicit about what that costs.
PNG and WebP are written losslessly and every untouched pixel survives exactly. A JPEG
cannot be edited without re-encoding the whole image, so the result card says so in
words — "re-encoded at maximum quality; pixels outside the mark change slightly" —
rather than implying an edit as surgical as the PNG case.

### 5.8 The fill, and how it must be presented

Every other part of this tool recovers the pixels that were there. The fill does not: it
makes up plausible ones from the surrounding image. That difference is the whole of its
UI design.

- **The control is off by default** and lives in Advanced, worded as what it does —
  "Fill what cannot be removed" — never as "improve" or "enhance".
- **It applies only where the exact path declined**: a region found and not invertible.
  It never runs where nothing was found, because an unfound mark has no rectangle and a
  fill over a guess is damage.
- **The result counts it separately.** "231 corrected · 4 filled", with filled frames
  drawn in their own colour on the timeline — the same treatment as untouched frames,
  because the user needs to find them just as much.
- **The word is "filled", never "fixed" or "cleaned".** A filled region is the one place
  in the output the tool cannot vouch for, and it says so in the same breath as reporting
  it.
- On a still, the fill needs a region: it runs where a mark was found and refused, or
  where the user drew one by hand and the engine could not invert it.

### 5.4 Advanced drawer

Collapsed by default. Open state persists per user, not per clip. Nothing in here is
required for a successful run.

| Control | Type | Default | Range / options |
| --- | --- | --- | --- |
| Detection mode | Select | Auto | `Auto` · `Corner only` (fast path) · `Full-frame sweep` (catches roaming marks) · `Manual region`. |
| Manual region | 4 numeric fields + canvas drag | — | `x, y, w, h`. Drawing a box on the preview fills these. |
| Alpha gain | Slider + numeric | Auto | `0.0 – 1.5`, step `0.01`. "Auto" means per-frame adaptive; moving the slider pins it. |
| Lock alpha per clip | Toggle | Off | Disables per-frame adaptation. For clips where auto-tuning misbehaves. |
| Mark variant | Select | Auto | Auto · the known template variants. |
| Sweep interval | Number | 15 | Frames between full-frame searches. Higher = faster, may miss brief marks. |
| Fill what cannot be removed | Toggle | **Off** | Synthesises pixels from the surroundings for regions the exact path declined. Off by default, labelled as invented rather than recovered, and counted separately in the result — never folded into "corrected". See §5.8. |
| Denoise | Select | Auto | `Off` · `Soft` · `Auto` · `Strong`. |
| Denoise sigma | Slider | Auto | `0 – 60`. Auto resolves per resolution; ~15 suits animation. |
| Output codec | Select | H.264 | H.264 · H.265. |
| Quality (CRF) | Slider | 14 | `10 – 28`, lower is better. Labelled in plain words, not just numbers. |
| Encoder | Select | Auto | Auto · Hardware · Software. Auto prefers hardware and falls back silently. |
| Output folder | Path + browse | Alongside source | |
| Filename pattern | Text | `{name}_clean{ext}` | Tokens documented inline. |

**Reset to defaults** sits at the bottom of the drawer and is always available.

### 5.5 Settings

| Tab | Contents |
| --- | --- |
| **General** | Theme (System / Dark / Light) · Language · Check for updates · Confirm before quitting with jobs running. |
| **Processing** | Max concurrent jobs (default: 1 — see §6) · Default encoder · Default output folder · Temp directory + current usage · Clear temp files. |
| **Diagnostics** | Opt-in toggles · Post-job feedback prompt on/off · View raw log · Open log folder · **Delete all local diagnostics**. Governed by `PLAN.md` §7. |
| **About** | Version, licences, third-party attribution (`PLAN.md` §10), links. |

---

## 6. Local-first, and the resource contract

### Why there are no file-size limits

The browser tools cap out around 100–200 MB because WebCodecs holds decoded frames in a
tab's memory budget and a refresh destroys the work. **We are a native application with
direct filesystem access, so those limits simply do not apply.** Files of 1 GB and beyond
process fine; the only real ceilings are disk space for the output and time.

This is a headline advantage over every web competitor and the UI should say so plainly —
once, in the empty state, not as a repeated boast.

### But it is genuinely expensive

Full decode → per-frame detection → re-encode is CPU-bound and memory-hungry. A long 4K
clip will saturate cores and hold significant RAM. Users deserve to know that **before**
they start, not thirty minutes in.

### Pre-flight estimate

Shown in the action bar before every run, derived from resolution × duration × frame count
× detection mode:

```
⚡ Estimated 2m 10s  ·  ~1.8 GB peak RAM  ·  340 MB temp disk  ·  8 cores
```

- Presented as an **estimate**, never a promise. Wording is explicitly hedged.
- Escalates to a **warning card** (amber) past a threshold: >500 MB input, >4K, >5 min
  duration, or estimated peak RAM above ~60% of physical.
- Escalates to a **blocking confirmation** only when estimated temp disk exceeds free
  space, or estimated peak RAM exceeds physical. That dialog offers concrete outs:
  proceed anyway · lower quality · software encoder · choose another temp drive.

### Live meters

A compact strip during processing:

```
CPU ▓▓▓▓▓▓▓░░ 78%   RAM 4.2 / 24 GB   ⏱ 1m 12s elapsed · ~58s left   fps 42
```

- Sampled at 1 Hz, smoothed, tabular figures so it does not jitter.
- Turns amber under sustained memory pressure or thermal throttling.
- Includes **frames/sec**, the number that actually tells a user whether a long job is
  healthy or thrashing.

### Concurrency default

**One job at a time by default.** Video processing is already parallel across cores
internally; running several clips at once mostly causes memory pressure and makes every
job slower. The setting exists in Settings > Processing for people who know their machine,
with an inline note explaining why the default is 1.

---

## 7. Job state machine

```
  queued ──▶ analysing ──▶ ready ──▶ processing ──▶ done
     │           │           │            │           │
     │           ▼           │            ▼           ▼
     │      no-mark-found    │        failed   done-with-skips
     │           │           │            │
     └───────────┴───────────┴────────────┴──▶ cancelled
```

| State | UI treatment |
| --- | --- |
| `queued` | Muted row, no progress. |
| `analysing` | Indeterminate until the probe reports a frame count, then determinate. |
| `ready` | Tracks drawn on the timeline; pre-flight estimate shown; Run enabled. |
| `no-mark-found` | **Not an error.** Informational: "No watermark detected." Offers Manual region and a one-click "report this clip" into the feedback flow — this is exactly the calibration signal `PLAN.md` §7 exists to capture. |
| `processing` | Determinate progress, live meters, Cancel available. |
| `done` | Success, output path, Reveal in folder. |
| `done-with-skips` | Success **with an explicit count**: "Done — 4 frames left untouched (occluded)." Clicking jumps the timeline to the first one. Never silently reported as clean. |
| `failed` | Plain-language cause, log excerpt, Retry, and Report. |
| `cancelled` | Partial output discarded; source never modified. |

---

## 8. Empty, loading, and error states

- **First run:** large centred drop target, one line stating that processing is fully
  local and unlimited in file size, and a link to how it works. No marketing.
- **Empty queue after use:** compact drop target, keeps the sidebar.
- **Unsupported file:** rejected at drop with the reason and the accepted extension list.
- **Corrupt / undecodable:** fails at analyse with the demuxer error surfaced verbatim in
  a `<details>` block, plain-language summary above it.
- **Missing FFmpeg sidecar:** blocking error naming the expected path — a packaging fault,
  and it should read like one rather than blaming the user.
- **Disk full mid-run:** job pauses rather than dying; offers retry after the user frees
  space; partial output is cleaned up.

---

## 9. Keyboard

| Key | Action |
| --- | --- |
| `Cmd/Ctrl+O` | Add files |
| `Cmd/Ctrl+Enter` | Run / Run all |
| `Cmd/Ctrl+.` | Cancel current job |
| `Space` | Play / pause preview |
| `,` / `.` | Previous / next frame |
| `Shift+,` / `Shift+.` | Previous / next flagged frame (occluded or low-confidence) |
| `Cmd/Ctrl+D` | Toggle Advanced drawer |
| `Cmd/Ctrl+,` | Settings |
| `Delete` | Remove selected job |
| `0` / `1` | Preview zoom to fit / 100% |
| `+` / `−` | Zoom the timeline in / out (when the timeline has focus; `0` fits) |
| `B` | Cycle compare mode |

Every action must be reachable without the keyboard. Nothing is shortcut-only.

---

## 10. Accessibility

- Full keyboard navigation with a visible focus ring on every interactive element.
- Colour is never the sole carrier of meaning (§2).
- Contrast meets WCAG AA against the dark ground; the accent is checked against both
  themes.
- Live regions announce job state changes, not per-percent progress updates.
- Timeline segments are focusable and expose their tooltip content as accessible labels.
- `prefers-reduced-motion` honoured.

---

## 11. Deliberately not building

Recorded so these get re-argued rather than quietly re-added:

- **A general video editor.** No trimming, filters, colour correction, or transitions.
- **Brush / manual inpainting.** Contradicts the exact-math premise (`PLAN.md` §2).
- **Cloud processing or accounts.** Local-only is the product.
- **A built-in updater UI beyond "check for updates."**
- **Per-clip presets library.** Defaults plus the Advanced drawer cover it; revisit only
  with real evidence that people re-enter the same settings.
- **Image support.** Video is the scope for v1. Prior art covers images well.
- **Timeline editing of tracks by hand** (dragging segments to retime). Manual region
  covers the real need at a fraction of the complexity.
