/**
 * Audio crossfade rendering utilities
 * 
 * Exports:
 * - AudioCrossfadeManager: Realtime preview audio smoothing
 * - OfflineAudioRenderer: Offline audio composition with true crossfades
 * - Fade utilities: Equal-power curves and scheduling helpers
 */

export { AudioCrossfadeManager } from './AudioCrossfadeManager';
export type { AudioCrossfadeConfig } from './AudioCrossfadeManager';

export { OfflineAudioRenderer, playbackSegmentsToRenderSegments } from './OfflineAudioRenderer';
export type { RenderConfig, RenderSegment } from './OfflineAudioRenderer';

export {
  applyFadeIn,
  applyFadeOut,
  scheduleFade,
  msToSamples,
  samplesToMs,
} from './fadeUtils';
