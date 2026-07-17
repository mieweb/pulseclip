/**
 * PulseClip app types.
 *
 * The transcript schema lives in ./ui-staging/types/transcript (staged for
 * @mieweb/ui) and is re-exported here so existing app imports keep working.
 * Only app-specific types (server API shapes) are defined below.
 */
export type {
  WordType,
  TranscriptWord,
  TranscriptSegment,
  Speaker,
  Transcript,
  EditableWord,
  PlaybackSegment,
  PlaybackSpeed,
  SpeedMarker,
} from './ui-staging/types/transcript';
export { PLAYBACK_SPEEDS } from './ui-staging/types/transcript';

import type { Transcript } from './ui-staging/types/transcript';

export interface Provider {
  id: string;
  displayName: string;
}

export interface TranscriptionResult {
  success: boolean;
  provider: Provider;
  transcript: Transcript;
  raw: any;
}

export interface FeaturedPulse {
  artipodId: string;
  title: string;
  thumbnail?: string;
  addedAt: string;
}
