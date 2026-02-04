export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
  speakerId?: string;
  confidence?: number;
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
