/** Core value types for the watermark engine. No DOM, no Electron, no Node I/O. */

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * A decoded frame in packed 8-bit channel order (RGB or RGBA).
 *
 * `channels: 3` matches FFmpeg's `rgb24` raw pipe; `channels: 4` matches canvas
 * ImageData. Only the first three channels are ever written — alpha is preserved.
 */
export interface Frame {
  readonly width: number
  readonly height: number
  readonly channels: 3 | 4
  readonly data: Uint8ClampedArray
}

/**
 * Per-pixel alpha of the watermark template, in `0..1`, row-major.
 *
 * This is the mark's own opacity at each pixel — not an image. It is derived from a
 * capture of the logo against black; see `alphaMapFromTemplate`.
 */
export interface AlphaMap {
  readonly width: number
  readonly height: number
  readonly data: Float32Array
}

export interface BlendOptions {
  /** Intensity multiplier applied to every alpha sample. Defaults to 1. */
  readonly gain?: number
}

/** Identifies which captured template a detection matched. */
export type MarkVariant =
  | "gemini-v1-36"
  | "gemini-v1-48"
  | "gemini-v1-96"
  | "gemini-v2-36"
  | "gemini-v2-96"

/** Why a frame ended up the way it did. Surfaced in the UI; never silently dropped. */
export type FrameState = "detected" | "interpolated" | "occluded"

export interface TrackedFrame {
  readonly rect: Rect
  readonly alpha: number
  readonly confidence: number
  readonly state: FrameState
}

/**
 * One watermark followed through time.
 *
 * The engine's detection output is a set of these, not a single rectangle — that is
 * what lets us represent a mark which appears mid-clip, drifts, and vanishes.
 * See docs/PLAN.md §4.
 */
export interface WatermarkTrack {
  readonly id: string
  readonly variant: MarkVariant
  readonly frames: Map<number, TrackedFrame>
  readonly firstFrame: number
  readonly lastFrame: number
}
