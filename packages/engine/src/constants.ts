/**
 * Reverse alpha blending constants.
 *
 * These values are consistent across every independent implementation of this
 * technique (see docs/PLAN.md §2 and §10). Do not tune them casually — they are
 * numerical guards, not quality knobs. The quality knob is `gain`.
 */

/** Alpha below this is indistinguishable from noise; those pixels are left alone. */
export const ALPHA_THRESHOLD = 0.002

/**
 * Alpha is clamped here to keep `1 - alpha` away from zero. At alpha = 0.99 the
 * inversion already amplifies encoder noise 100x; beyond that it explodes.
 */
export const MAX_ALPHA = 0.99

/** The Gemini/Veo mark is composited as pure white. */
export const LOGO_VALUE = 255

/** Default intensity multiplier for current Gemini/Veo marks. Legacy marks use 1.0. */
export const DEFAULT_GAIN = 0.6
