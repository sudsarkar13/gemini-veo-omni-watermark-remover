import type { Rect } from "./types.ts"

/**
 * Where the mark is expected to sit, and how big.
 *
 * These are *priors* that seed the detector, never the final answer. Every tool we
 * studied treats the corner formula as ground truth and therefore cannot see a mark
 * anywhere else; here the priors only order the search. See docs/PLAN.md §4.
 */

export interface CornerProfile {
  readonly id: string
  readonly label: string
  /** Square edge length in pixels. */
  readonly size: number
  readonly marginRight: number
  readonly marginBottom: number
  /**
   * The exact frame size this profile was measured at.
   *
   * A profile that merely *fits* some other resolution is not calibrated for it —
   * conflating those would let us claim measured confidence for a guess. Margins do
   * not scale linearly across encoding profiles, so a new resolution needs its own
   * measurement, not arithmetic.
   */
  readonly frameWidth: number
  readonly frameHeight: number
}

/**
 * Profiles measured from real Veo output at 720p. The two variants correlate with
 * the encoder bitrate tier, which is why both exist at the same resolution.
 */
export const VEO_720P_STANDARD: CornerProfile = {
  id: "veo-720p-1",
  label: "Veo 720p standard (~1.5 Mbps tier)",
  size: 48,
  marginRight: 72,
  marginBottom: 72,
  frameWidth: 1280,
  frameHeight: 720,
}

export const VEO_720P_COMPACT: CornerProfile = {
  id: "veo-720p-2",
  label: "Veo 720p compact (~7 Mbps tier)",
  size: 44,
  marginRight: 29,
  marginBottom: 40,
  frameWidth: 1280,
  frameHeight: 720,
}

export const CALIBRATED_PROFILES: readonly CornerProfile[] = [
  VEO_720P_STANDARD,
  VEO_720P_COMPACT,
]

/**
 * Generic bottom-right placement, derived from the frame's short edge.
 *
 * This is the fallback for resolutions nobody has calibrated — notably 4K, 1:1, and
 * 9:16, which is most real Veo output. It gets the detector close enough to refine
 * from; it is not a measurement.
 */
export function genericCornerRect(width: number, height: number): Rect {
  assertPositiveDimensions(width, height)
  const base = Math.min(width, height)
  const size = Math.max(24, Math.min(Math.round(base / 15), base))
  const margin = Math.round(base / 10)
  return {
    x: Math.max(0, width - margin - size),
    y: Math.max(0, height - margin - size),
    width: size,
    height: size,
  }
}

/** Resolves a calibrated profile against a specific frame size. */
export function profileRect(profile: CornerProfile, width: number, height: number): Rect {
  assertPositiveDimensions(width, height)
  return {
    x: width - profile.marginRight - profile.size,
    y: height - profile.marginBottom - profile.size,
    width: profile.size,
    height: profile.size,
  }
}

export interface CornerCandidate {
  readonly rect: Rect
  readonly profile: CornerProfile | null
  readonly calibrated: boolean
}

/**
 * Ordered corner guesses for this frame size: calibrated profiles that fit, then the
 * generic fallback. The detector scores all of them rather than trusting the first.
 */
export function cornerCandidates(width: number, height: number): CornerCandidate[] {
  assertPositiveDimensions(width, height)
  const candidates: CornerCandidate[] = []

  for (const profile of profilesFor(width, height)) {
    candidates.push({ rect: profileRect(profile, width, height), profile, calibrated: true })
  }

  const generic = genericCornerRect(width, height)
  const duplicate = candidates.some(
    (c) => c.rect.x === generic.x && c.rect.y === generic.y && c.rect.width === generic.width
  )
  if (!duplicate) {
    candidates.push({ rect: generic, profile: null, calibrated: false })
  }

  return candidates
}

/** Profiles actually measured at this exact frame size. Often empty — that is honest. */
export function profilesFor(width: number, height: number): CornerProfile[] {
  return CALIBRATED_PROFILES.filter(
    (profile) => profile.frameWidth === width && profile.frameHeight === height
  )
}

/**
 * True when we have a measured profile for this exact frame size rather than a guess.
 *
 * Returns false for 4K, 1:1, and 9:16 today. That is a known gap, not a bug, and the
 * diagnostics report leans on it to flag clips worth collecting (docs/PLAN.md §7).
 */
export function hasCalibratedProfile(width: number, height: number): boolean {
  return profilesFor(width, height).length > 0
}

/** Clamps a rect to the frame, preserving its size where possible. */
export function clampRect(rect: Rect, width: number, height: number): Rect {
  const w = Math.min(rect.width, width)
  const h = Math.min(rect.height, height)
  return {
    x: Math.max(0, Math.min(rect.x, width - w)),
    y: Math.max(0, Math.min(rect.y, height - h)),
    width: w,
    height: h,
  }
}

function assertPositiveDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`frame dimensions must be positive integers, received ${width}x${height}`)
  }
}
