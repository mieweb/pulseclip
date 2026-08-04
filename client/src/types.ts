/**
 * PulseClip app types.
 *
 * The transcript schema lives in @mieweb/ui (TranscriptView) and is
 * re-exported here so existing app imports keep working. Only app-specific
 * types (server API shapes) are defined below.
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
} from '@mieweb/ui/components/TranscriptView';
export { PLAYBACK_SPEEDS } from '@mieweb/ui/components/TranscriptView';

import type { Transcript } from '@mieweb/ui/components/TranscriptView';

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
