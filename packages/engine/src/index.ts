/** Public surface of the watermark engine. */

export * from "./constants.ts"
export * from "./types.ts"
export { blend, unblend } from "./blend.ts"
export { alphaMapFromTemplate, peakAlpha, scaleAlphaMap, withGain } from "./alpha-map.ts"
export {
  CALIBRATED_PROFILES,
  VEO_720P_COMPACT,
  VEO_720P_INSET,
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
export {
  buildIntegral,
  makeTemplate,
  patchSum,
  patchSumSquares,
  referenceKernel,
  sobelMagnitude,
  templateFromAlphaMap,
  toGrayscale,
  type CorrelationKernel,
  type Grayscale,
  type IntegralImage,
  type Template,
} from "./correlate.ts"
export { verifyReversibility, type VerifyOptions, type VerifyResult } from "./verify.ts"
export {
  DEFAULT_DISCOVERY_THRESHOLD,
  DEFAULT_THRESHOLD,
  DEFAULT_WEIGHTS,
  MIN_COARSE_TEMPLATE,
  analyseFrame,
  defaultSizes,
  downsample2,
  overlap,
  scoreAt,
  searchWindow,
  sizeTemplate,
  suppressOverlaps,
  sweepFrame,
  varianceScore,
  type Candidate,
  type FrameAnalysis,
  type FusedWeights,
  type SearchOptions,
  type SizedTemplate,
} from "./detect.ts"
export {
  buildTracks,
  consolidate,
  ingestFrame,
  type ConsolidationResult,
  type MutableTrack,
  type Observation,
  type TrackOptions,
} from "./track.ts"
export {
  coverage,
  createPlanner,
  planClip,
  planClipAsync,
  renderFrame,
  type ClipPlanner,
  type ClipDiagnostics,
  type ClipPlan,
  type Coverage,
  type FrameRange,
  type DetectionMode,
  type FrameReport,
  type PlanOptions,
  type RefusedRegion,
  type RenderOptions,
  type RenderReport,
} from "./pipeline.ts"
export { decodePpm, encodePpm } from "./ppm.ts"
export { defaultTemplate, loadTemplatePpm, syntheticDiamond, veoDiamond48 } from "./templates.ts"
export { inpaint, type InpaintOptions, type InpaintReport } from "./inpaint.ts"
