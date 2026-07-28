import { AssemblyAI } from 'assemblyai';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
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
    // For local files, extract the audio track before uploading: the SDK
    // otherwise ships the ENTIRE video to AssemblyAI (a 15-minute clip is
    // ~0.5-1 GB; its mono 16k audio is ~5 MB), which dominated long-video
    // transcription time. Extraction failure falls back to the original file.
    let audioInput = mediaUrl;
    let tempAudio: string | null = null;
    if (!/^https?:\/\//i.test(mediaUrl)) {
      const candidate = join(tmpdir(), `aai-${randomUUID()}.m4a`);
      try {
        await promisify(execFile)('ffmpeg', [
          '-y', '-i', mediaUrl, '-vn', '-ac', '1', '-ar', '16000',
          '-c:a', 'aac', '-b:a', '48k', candidate,
        ]);
        tempAudio = candidate;
        audioInput = candidate;
      } catch {
        console.warn('[assemblyai] audio extraction failed, uploading original media');
      }
    }
    try {
      return await this.transcribeAudio(audioInput, options);
    } finally {
      if (tempAudio) unlink(tempAudio).catch(() => {});
    }
  }

  private async transcribeAudio(
    audioInput: string,
    options?: TranscriptionOptions
  ): Promise<ProviderResult> {
    // Submit transcription request
    // Enable disfluencies (filler words like "um", "uh") for raw transcription
    // Disable format_text to prevent cleanup and get precise output
    const transcript = await this.client.transcripts.transcribe({
      audio: audioInput,
      speaker_labels: options?.speakerLabels ?? false,
      // universal-3-pro was deprecated by AssemblyAI (July 2026); universal-3-5-pro replaces it
      speech_models: options?.speech_models ?? ["universal-3-5-pro", "universal-2"],
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
