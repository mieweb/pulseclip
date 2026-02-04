// Normalized transcript types
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

// Provider interface
export interface ProviderResult {
  normalized: Transcript;
  raw: any;
}

export interface TranscriptionOptions {
  speakerLabels?: boolean;
  [key: string]: any;
}

export interface TranscriptionProvider {
  id: string;
  displayName: string;
  transcribe(mediaUrl: string, options?: TranscriptionOptions): Promise<ProviderResult>;
}
