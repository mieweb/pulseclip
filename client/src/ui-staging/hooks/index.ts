/**
 * Headless hooks staged for @mieweb/ui (see ../README.md).
 */
export {
  useTranscriptEdits,
  insertSilences,
  initEditableWords,
  buildPlaybackSegments,
  getSpeedAtIndex,
  DEFAULT_FILLER_WORDS,
  DEFAULT_MIN_SILENCE_MS,
  DEFAULT_NL_SILENCE_MS,
} from './useTranscriptEdits';
export type {
  UseTranscriptEditsOptions,
  UseTranscriptEditsResult,
  TranscriptEditStats,
  TranscriptClipboard,
  FillerAnalysis,
  SilenceThresholdCount,
} from './useTranscriptEdits';
