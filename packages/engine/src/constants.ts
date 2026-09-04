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

/**
 * Largest alpha change permitted between adjacent frames.
 *
 * Per-frame intensity is measured independently, so a single bad frame — a hard
 * occlusion, a blown highlight — can produce a wildly wrong estimate. Uncapped, that
 * shows up as a visible flash in the output, which is far more objectionable than a
 * slightly imperfect removal. Capping the step means one bad reading is absorbed
 * rather than displayed.
 */
export const ALPHA_STEP_CAP = 0.05

/**
 * Floor on the background spread used to judge a correction, in 8-bit levels.
 *
 * The verifier scores a correction against the variation of the ring around it, which
 * keeps it scale-free across flat sky and busy foliage alike. That breaks down when
 * the surroundings are flatter than the codec's own noise: against black sky the ring
 * measures a standard deviation of ~0.5, and a correction accurate to under one level
 * scores as a three-sigma outlier and is thrown away. The mark stays on screen while
 * the run reports success.
 *
 * A background cannot be known more precisely than the encoder represents it, so the
 * ring's apparent spread is floored at the quantisation noise. This is a statement
 * about measurement uncertainty, not a tolerance to be widened when something fails.
 */
export const MIN_RING_SPREAD = 2
