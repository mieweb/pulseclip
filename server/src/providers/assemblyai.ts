import { AssemblyAI } from 'assemblyai';
import type {
  TranscriptionProvider,
  ProviderResult,
  TranscriptionOptions,
  Transcript,
  TranscriptWord,
  TranscriptSegment,
  Speaker,
} from '../types/transcription.js';

export class AssemblyAIProvider implements TranscriptionProvider {
  id = 'assemblyai';
  displayName = 'AssemblyAI';
  private client: AssemblyAI;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('AssemblyAI API key is required');
    }
    this.client = new AssemblyAI({ apiKey });
  }

  async transcribe(
    mediaUrl: string,
    options?: TranscriptionOptions
  ): Promise<ProviderResult> {
    // Submit transcription request
    // Enable disfluencies (filler words like "um", "uh") for raw transcription
    // Disable format_text to prevent cleanup and get precise output
    const transcript = await this.client.transcripts.transcribe({
      audio: mediaUrl,
      speaker_labels: options?.speakerLabels ?? false,
      disfluencies: true,      // Include filler words (um, uh, etc.)
      format_text: false,      // No text cleanup - raw precise output
    });

    if (transcript.status === 'error') {
      throw new Error(`AssemblyAI transcription failed: ${transcript.error}`);
    }

    // Normalize the response
    const normalized = this.normalize(transcript);

    return {
      normalized,
      raw: transcript,
    };
  }

  private normalize(transcript: any): Transcript {
    const words: TranscriptWord[] = [];
    const segments: TranscriptSegment[] = [];
    const speakersMap = new Map<string, Speaker>();

    // Process words with timestamps
    if (transcript.words) {
      for (const word of transcript.words) {
        words.push({
          text: word.text,
          startMs: word.start,
          endMs: word.end,
          confidence: word.confidence,
          speakerId: word.speaker ? `speaker_${word.speaker}` : undefined,
        });

        // Track speakers
        if (word.speaker) {
          const speakerId = `speaker_${word.speaker}`;
          if (!speakersMap.has(speakerId)) {
            speakersMap.set(speakerId, {
              id: speakerId,
              name: `Speaker ${word.speaker}`,
            });
          }
        }
      }
    }

    // Process utterances (segments) if speaker labels are enabled
    if (transcript.utterances) {
      for (const utterance of transcript.utterances) {
        const segmentWords = words.filter(
          (w) =>
            w.startMs >= utterance.start &&
            w.endMs <= utterance.end &&
            w.speakerId === `speaker_${utterance.speaker}`
        );

        segments.push({
          text: utterance.text,
          startMs: utterance.start,
          endMs: utterance.end,
          speakerId: `speaker_${utterance.speaker}`,
          words: segmentWords,
        });
      }
    }

    const speakers = speakersMap.size > 0 ? Array.from(speakersMap.values()) : undefined;

    return {
      durationMs: transcript.audio_duration ? transcript.audio_duration * 1000 : 0,
      speakers,
      words,
      segments: segments.length > 0 ? segments : undefined,
    };
  }
}
