/** Public surface of the watermark engine. */

export * from "./constants.ts"
export * from "./types.ts"
export { blend, unblend } from "./blend.ts"
export { alphaMapFromTemplate, peakAlpha, scaleAlphaMap, withGain } from "./alpha-map.ts"
export {
  CALIBRATED_PROFILES,
  VEO_720P_COMPACT,
  VEO_720P_STANDARD,
  clampRect,
  cornerCandidates,
  genericCornerRect,
  hasCalibratedProfile,
  profileRect,
  profilesFor,
  type CornerCandidate,
  type CornerProfile,
} from "./geometry.ts"
