/** Type of transcript word - 'word' for spoken content, 'silence' for detected gaps, 'silence-newline' for longer pauses */
export type WordType = 'word' | 'silence' | 'silence-newline';

export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
  speakerId?: string;
  confidence?: number;
  /** Type of word: 'word' for spoken content, 'silence' for detected gaps. Defaults to 'word' */
  wordType?: WordType;
}

/**
 * An editable word that references the original transcript word.
 * Used in the edited timeline to track deletions and reordering.
 */
export interface EditableWord {
  /** Reference to original word in transcript.words */
  originalIndex: number;
  /** The word data (from original transcript) */
  word: TranscriptWord;
  /** Whether this word is marked as deleted */
  deleted: boolean;
  /** Whether this word was inserted (pasted from clipboard) */
  inserted?: boolean;
}

/**
 * Represents a contiguous segment of playback from the original media.
 * Used when playing back an edited timeline with potentially reordered/deleted words.
 */
export interface PlaybackSegment {
  startMs: number;
  endMs: number;
  /** Indices into the editedWords array that this segment covers */
  editedIndices: number[];
}

export interface TranscriptSegment {
  text: string;
  startMs: number;
  endMs: number;
  speakerId?: string;
  words: TranscriptWord[];
}

export interface Speaker {
  id: string;
  name?: string;
}

export interface Transcript {
  durationMs: number;
  speakers?: Speaker[];
  words: TranscriptWord[];
  segments?: TranscriptSegment[];
}

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
