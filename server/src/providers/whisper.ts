import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync, unlinkSync } from 'fs';
import type {
  TranscriptionProvider,
  ProviderResult,
  TranscriptionOptions,
  Transcript,
  TranscriptWord,
} from '../types/transcription.js';
import { detectSilences, applySilenceGaps } from '../silence.js';

const execFileAsync = promisify(execFile);

export interface WhisperConfig {
  /** Path to a whisper.cpp ggml model file (e.g. models/ggml-base.en.bin) */
  modelPath: string;
  /** Provider id (default: whisper) - must be unique when registering multiple models */
  id?: string;
  /** Display name shown in the provider dropdown (default: Whisper (local)) */
  displayName?: string;
  /** whisper.cpp CLI executable (default: whisper-cli on PATH) */
  binPath?: string;
  /** ffmpeg executable used to extract audio (default: ffmpeg on PATH) */
  ffmpegPath?: string;
  /** ffprobe executable used to read media duration (default: ffprobe on PATH) */
  ffprobePath?: string;
  /** Spoken language, or 'auto' to detect (default: auto) */
  language?: string;
}

interface WhisperToken {
  text: string;
  p: number;
  offsets: { from: number; to: number };
}

interface WhisperSegment {
  text: string;
  offsets: { from: number; to: number };
  tokens?: WhisperToken[];
}

/**
 * Local transcription via whisper.cpp.
 *
 * Runs entirely on the server - no cloud API, no per-minute cost. Media is
 * converted to 16kHz mono WAV with ffmpeg, then transcribed with word-level
 * segments (--max-len 1 --split-on-word) so the output maps directly onto the
 * normalized word schema.
 *
 * Note: Whisper word timestamps are alignment estimates and are generally
 * less precise than AssemblyAI's - good enough for seeking and editing, but
 * expect slightly softer word boundaries.
 */
export class WhisperProvider implements TranscriptionProvider {
  id: string;
  displayName: string;
  // Local transcription is much slower than a cloud API; always use the
  // async job + polling flow so HTTP requests never hang for minutes.
  alwaysAsync = true;

  private modelPath: string;
  private binPath: string;
  private ffmpegPath: string;
  private ffprobePath: string;
  private language: string;

  constructor(config: WhisperConfig) {
    if (!config.modelPath) {
      throw new Error('Whisper model path is required');
    }
    this.id = config.id || 'whisper';
    this.displayName = config.displayName || 'Whisper (local)';
    this.modelPath = config.modelPath;
    this.binPath = config.binPath || 'whisper-cli';
    this.ffmpegPath = config.ffmpegPath || 'ffmpeg';
    this.ffprobePath = config.ffprobePath || 'ffprobe';
    this.language = config.language || 'auto';
  }

  async transcribe(
    mediaPath: string,
    options?: TranscriptionOptions
  ): Promise<ProviderResult> {
    const workBase = join(tmpdir(), `pulseclip-whisper-${randomUUID()}`);
    const wavPath = `${workBase}.wav`;
    const jsonPath = `${workBase}.json`;

    try {
      // whisper.cpp requires 16kHz mono WAV input
      await execFileAsync(this.ffmpegPath, [
        '-y', '-i', mediaPath, '-vn', '-ar', '16000', '-ac', '1', wavPath,
      ]);

      const durationMs = await this.probeDurationMs(mediaPath);

      await execFileAsync(
        this.binPath,
        [
          '-m', this.modelPath,
          '-f', wavPath,
          '-ml', '1',        // one word per segment
          '-sow',            // split on word boundaries, not tokens
          '-ojf',            // full JSON output (includes token probabilities)
          '-of', workBase,
          '-np',
          '-l', options?.language ?? this.language,
        ],
        { maxBuffer: 64 * 1024 * 1024 }
      );

      const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      const normalized = this.normalize(raw, durationMs);

      // whisper.cpp emits contiguous word timestamps (pauses get absorbed into
      // word spans), so the editor would never see a silence. Re-open the real
      // gaps using ffmpeg silencedetect on the WAV we already extracted.
      try {
        const silences = await detectSilences(wavPath, durationMs);
        applySilenceGaps(normalized.words, silences);
      } catch (error) {
        console.warn('Silence detection failed; transcript keeps contiguous timestamps:', error);
      }

      return { normalized, raw };
    } finally {
      for (const f of [wavPath, jsonPath]) {
        try { unlinkSync(f); } catch { /* temp file may not exist */ }
      }
    }
  }

  private async probeDurationMs(mediaPath: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync(this.ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        mediaPath,
      ]);
      return Math.round(parseFloat(stdout.trim()) * 1000) || 0;
    } catch {
      return 0;
    }
  }

  private normalize(raw: any, durationMs: number): Transcript {
    const words: TranscriptWord[] = [];

    for (const seg of (raw.transcription ?? []) as WhisperSegment[]) {
      const text = (seg.text ?? '').trim();
      if (!text) continue;

      // Special tokens like [_BEG_] / [_TT_500] carry no confidence signal
      const realTokens = (seg.tokens ?? []).filter((t) => !t.text.startsWith('[_'));
      const confidence = realTokens.length
        ? realTokens.reduce((sum, t) => sum + t.p, 0) / realTokens.length
        : undefined;

      words.push({
        text,
        startMs: seg.offsets.from,
        endMs: seg.offsets.to,
        confidence,
      });
    }

    return {
      durationMs: durationMs || (words.length ? words[words.length - 1].endMs : 0),
      words,
    };
  }
}
