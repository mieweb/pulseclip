import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

// -30dB noise floor is ffmpeg's conventional speech/silence boundary; 300ms
// matches the smallest silence threshold the editor UI offers (0.3s)
const SILENCE_NOISE_FLOOR = '-30dB';
const SILENCE_MIN_SECONDS = 0.3;

export interface SilenceInterval {
  startMs: number;
  endMs: number;
}

/** Word shape shared with the normalized transcript (subset of TranscriptWord) */
interface TimedWord {
  startMs: number;
  endMs: number;
}

/**
 * Detects silence intervals in a media file with ffmpeg silencedetect.
 * No model involved — this is signal-level ground truth, and it is the only
 * silence source for local Whisper, whose word timestamps come out contiguous.
 */
export async function detectSilences(mediaPath: string, durationMs?: number): Promise<SilenceInterval[]> {
  const { stderr } = await execFileAsync(
    ffmpegPath,
    [
      '-i', mediaPath,
      '-af', `silencedetect=noise=${SILENCE_NOISE_FLOOR}:d=${SILENCE_MIN_SECONDS}`,
      '-f', 'null', '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  );

  const silences: SilenceInterval[] = [];
  let openStartMs: number | null = null;

  for (const line of stderr.split('\n')) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (start) {
      openStartMs = Math.max(0, Math.round(parseFloat(start[1]) * 1000));
      continue;
    }
    const end = line.match(/silence_end:\s*([\d.]+)/);
    if (end && openStartMs !== null) {
      silences.push({ startMs: openStartMs, endMs: Math.round(parseFloat(end[1]) * 1000) });
      openStartMs = null;
    }
  }

  // A file that ends during silence logs silence_start with no matching end
  if (openStartMs !== null && durationMs && durationMs > openStartMs) {
    silences.push({ startMs: openStartMs, endMs: durationMs });
  }

  return silences;
}

/**
 * Opens real gaps in a word list around detected silences by trimming word
 * boundaries that overlap them. Whisper smears the preceding word's end across
 * pauses, so a word spanning a whole silence keeps its start and ends where the
 * silence begins. The editor synthesizes silence chips from inter-word gaps, so
 * after this pass the client needs no changes to show them.
 */
export function applySilenceGaps<T extends TimedWord>(words: T[], silences: SilenceInterval[]): T[] {
  for (const silence of silences) {
    for (const word of words) {
      if (word.endMs <= silence.startMs || word.startMs >= silence.endMs) continue;

      if (word.startMs < silence.startMs) {
        // Word begins before the silence: pull its end back to the silence start
        word.endMs = silence.startMs;
      } else if (word.endMs > silence.endMs) {
        // Word begins inside the silence but continues past it: push its start out
        word.startMs = silence.endMs;
      }
      // Words fully inside a silence are left untouched — likely hallucinated,
      // but truncating them to zero length would break editor assumptions
    }
  }
  return words;
}
