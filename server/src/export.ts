import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, unlinkSync, renameSync } from 'fs';

const execFileAsync = promisify(execFile);

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';

// Renders can be long for big files; kill runaway ffmpeg after 10 minutes
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;

/** Filenames the export writes into an artipod folder — must stay excluded from media detection */
export const EXPORT_FILENAMES = ['export.mp4', 'export.m4a'];

export interface ExportSegment {
  startMs: number;
  endMs: number;
}

/** Minimal shape of an edited word as persisted in edits.json / sent by the client */
interface EditableWordLike {
  originalIndex: number;
  deleted?: boolean;
  inserted?: boolean;
  word: {
    startMs: number;
    endMs: number;
  };
}

/**
 * Builds the cut list (keep-segments) from an edited word list.
 * Mirrors buildPlaybackSegments in @mieweb/ui useTranscriptEdits.ts — keep the
 * two in sync so an export always matches play-as-edited: consecutive words in
 * original order merge into one segment; inserted (pasted) words each get their
 * own segment since they may duplicate a range that plays elsewhere.
 */
export function buildExportSegments(editedWords: EditableWordLike[]): ExportSegment[] {
  const segments: ExportSegment[] = [];
  let currentSegment: ExportSegment | null = null;
  let lastOriginalIndex = -2; // -2 so the first word always starts a new segment
  let lastWasInserted = false;

  for (const ew of editedWords) {
    if (ew.deleted) continue;

    const isConsecutive =
      !ew.inserted &&
      !lastWasInserted &&
      ew.originalIndex === lastOriginalIndex + 1;

    if (currentSegment && isConsecutive) {
      currentSegment.endMs = ew.word.endMs;
    } else {
      if (currentSegment) {
        segments.push(currentSegment);
      }
      currentSegment = { startMs: ew.word.startMs, endMs: ew.word.endMs };
    }

    lastOriginalIndex = ew.originalIndex;
    lastWasInserted = ew.inserted ?? false;
  }

  if (currentSegment) {
    segments.push(currentSegment);
  }

  return segments.filter((s) => s.endMs > s.startMs && s.startMs >= 0);
}

async function probeStreams(mediaPath: string): Promise<{ hasVideo: boolean; hasAudio: boolean }> {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    mediaPath,
  ]);
  const types = stdout.trim().split('\n').map((t) => t.trim());
  return {
    hasVideo: types.includes('video'),
    hasAudio: types.includes('audio'),
  };
}

const toSeconds = (ms: number): string => (ms / 1000).toFixed(3);

/**
 * Builds the ffmpeg filter graph: per-segment trim/atrim reset to t=0, then a
 * single concat. Written to a script file since the graph grows with segment
 * count and would overflow the argv limit on heavily edited transcripts.
 */
function buildFilterScript(segments: ExportSegment[], hasVideo: boolean, hasAudio: boolean): string {
  const chains: string[] = [];
  const concatInputs: string[] = [];

  segments.forEach((seg, i) => {
    const start = toSeconds(seg.startMs);
    const end = toSeconds(seg.endMs);
    if (hasVideo) {
      chains.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}]`);
      concatInputs.push(`[v${i}]`);
    }
    if (hasAudio) {
      chains.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]`);
      concatInputs.push(`[a${i}]`);
    }
  });

  const outLabels = `${hasVideo ? '[outv]' : ''}${hasAudio ? '[outa]' : ''}`;
  chains.push(
    `${concatInputs.join('')}concat=n=${segments.length}:v=${hasVideo ? 1 : 0}:a=${hasAudio ? 1 : 0}${outLabels}`
  );

  return chains.join(';\n');
}

export interface ExportResult {
  filename: string;
  durationMs: number;
}

/**
 * Renders the edit list to a new media file inside the artipod folder.
 * Re-encodes (required for frame-accurate cuts); writes to a dotfile first so a
 * failed render never leaves a half-written export where the UI can find it.
 */
export async function renderExport(
  mediaPath: string,
  artipodPath: string,
  segments: ExportSegment[]
): Promise<ExportResult> {
  if (segments.length === 0) {
    throw new Error('Nothing to export: the edit list has no remaining words');
  }

  const { hasVideo, hasAudio } = await probeStreams(mediaPath);
  if (!hasVideo && !hasAudio) {
    throw new Error('Source file has no audio or video streams');
  }

  const filename = hasVideo ? 'export.mp4' : 'export.m4a';
  const scriptPath = join(tmpdir(), `pulseclip-export-${randomUUID()}.filter`);
  const tmpOutPath = join(artipodPath, `.export-tmp-${randomUUID()}${hasVideo ? '.mp4' : '.m4a'}`);

  writeFileSync(scriptPath, buildFilterScript(segments, hasVideo, hasAudio));

  const args = ['-y', '-i', mediaPath, '-filter_complex_script', scriptPath];
  if (hasVideo) {
    args.push('-map', '[outv]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  }
  if (hasAudio) {
    args.push('-map', '[outa]', '-c:a', 'aac');
  }
  args.push('-movflags', '+faststart', tmpOutPath);

  try {
    await execFileAsync(ffmpegPath, args, {
      timeout: RENDER_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    renameSync(tmpOutPath, join(artipodPath, filename));
  } catch (error) {
    try { unlinkSync(tmpOutPath); } catch { /* may not exist */ }
    throw error;
  } finally {
    try { unlinkSync(scriptPath); } catch { /* may not exist */ }
  }

  const durationMs = segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  return { filename, durationMs };
}
