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
export const EXPORT_FILENAMES = ['export.mp4', 'export.m4a', 'export.srt'];

export interface ExportSegment {
  startMs: number;
  endMs: number;
  /** Playback-rate multiplier baked into the render (1 = realtime) */
  speed: number;
}

/** Minimal shape of an edited word as persisted in edits.json / sent by the client */
interface EditableWordLike {
  originalIndex: number;
  deleted?: boolean;
  inserted?: boolean;
  word: {
    text?: string;
    startMs: number;
    endMs: number;
    wordType?: string;
  };
}

/** Speed marker as persisted alongside the edit list (ui SpeedMarker shape) */
export interface SpeedMarkerLike {
  wordIndex: number;
  speed: number;
}

/** A spoken word placed on the EXPORTED timeline (for captions) */
export interface CaptionWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface ExportPlan {
  segments: ExportSegment[];
  captionWords: CaptionWord[];
  durationMs: number;
}

// atempo only accepts 0.5–2.0, which happens to be the editor's speed range;
// clamp defensively so a bad marker can't produce an invalid filter
const clampSpeed = (speed: number): number =>
  Math.min(2, Math.max(0.5, Number.isFinite(speed) && speed > 0 ? speed : 1));

/** Effective speed at an edited-word index — mirrors getSpeedAtIndex in @mieweb/ui */
function speedAtIndex(
  index: number,
  markers: SpeedMarkerLike[],
  defaultSpeed: number
): number {
  let best: SpeedMarkerLike | null = null;
  for (const marker of markers) {
    if (marker.wordIndex <= index && (!best || marker.wordIndex > best.wordIndex)) {
      best = marker;
    }
  }
  return clampSpeed(best ? best.speed : defaultSpeed);
}

/**
 * Builds the render plan from an edited word list: the cut list (keep-segments,
 * split wherever the effective speed changes so each can carry one rate) and
 * every spoken word mapped onto the exported timeline for captions.
 *
 * Segment merging mirrors buildPlaybackSegments in @mieweb/ui — keep the two
 * in sync so an export always matches play-as-edited: consecutive words in
 * original order merge into one segment; inserted (pasted) words each get their
 * own segment since they may duplicate a range that plays elsewhere.
 */
export function buildExportPlan(
  editedWords: EditableWordLike[],
  speedMarkers: SpeedMarkerLike[] = [],
  defaultSpeed = 1
): ExportPlan {
  const segments: ExportSegment[] = [];
  const captionWords: CaptionWord[] = [];
  let currentSegment: ExportSegment | null = null;
  let lastOriginalIndex = -2; // -2 so the first word always starts a new segment
  let lastWasInserted = false;
  // Exported-timeline ms already emitted by CLOSED segments
  let outBaseMs = 0;

  const closeSegment = () => {
    if (currentSegment) {
      outBaseMs +=
        (currentSegment.endMs - currentSegment.startMs) / currentSegment.speed;
      segments.push(currentSegment);
      currentSegment = null;
    }
  };

  for (let i = 0; i < editedWords.length; i++) {
    const ew = editedWords[i];
    if (ew.deleted) continue;

    const speed = speedAtIndex(i, speedMarkers, defaultSpeed);
    const isConsecutive =
      !ew.inserted &&
      !lastWasInserted &&
      ew.originalIndex === lastOriginalIndex + 1 &&
      currentSegment !== null &&
      currentSegment.speed === speed;

    if (currentSegment && isConsecutive) {
      currentSegment.endMs = ew.word.endMs;
    } else {
      closeSegment();
      currentSegment = { startMs: ew.word.startMs, endMs: ew.word.endMs, speed };
    }

    // Spoken words (not silence pseudo-words) land on the exported timeline
    const isSpoken = !ew.word.wordType || ew.word.wordType === 'word';
    if (isSpoken && ew.word.text && currentSegment) {
      captionWords.push({
        text: ew.word.text,
        startMs: outBaseMs + (ew.word.startMs - currentSegment.startMs) / speed,
        endMs: outBaseMs + (ew.word.endMs - currentSegment.startMs) / speed,
      });
    }

    lastOriginalIndex = ew.originalIndex;
    lastWasInserted = ew.inserted ?? false;
  }

  closeSegment();

  const validSegments = segments.filter(
    (s) => s.endMs > s.startMs && s.startMs >= 0
  );
  const durationMs = validSegments.reduce(
    (sum, s) => sum + (s.endMs - s.startMs) / s.speed,
    0
  );
  return { segments: validSegments, captionWords, durationMs };
}

const srtTimestamp = (ms: number): string => {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3600000);
  const m = Math.floor((clamped % 3600000) / 60000);
  const s = Math.floor((clamped % 60000) / 1000);
  const frac = clamped % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(frac, 3)}`;
};

// Cue shaping roughly per broadcast conventions: ~2 lines of ~32 chars,
// break on dead air, never linger past 5s
const CUE_MAX_CHARS = 64;
const CUE_MAX_GAP_MS = 800;
const CUE_MAX_DURATION_MS = 5000;
const CUE_MIN_DURATION_MS = 300;

/** Groups exported-timeline words into an SRT document */
export function buildSrt(captionWords: CaptionWord[]): string {
  const cues: { startMs: number; endMs: number; text: string }[] = [];
  let cue: { startMs: number; endMs: number; words: string[]; chars: number } | null = null;

  const closeCue = () => {
    if (cue) {
      cues.push({
        startMs: cue.startMs,
        endMs: Math.max(cue.endMs, cue.startMs + CUE_MIN_DURATION_MS),
        text: cue.words.join(' '),
      });
      cue = null;
    }
  };

  for (const word of captionWords) {
    const breaks =
      cue !== null &&
      (cue.chars + word.text.length + 1 > CUE_MAX_CHARS ||
        word.startMs - cue.endMs > CUE_MAX_GAP_MS ||
        word.endMs - cue.startMs > CUE_MAX_DURATION_MS);
    if (breaks) closeCue();

    if (!cue) {
      cue = { startMs: word.startMs, endMs: word.endMs, words: [], chars: 0 };
    }
    cue.words.push(word.text);
    cue.chars += word.text.length + 1;
    cue.endMs = word.endMs;
  }
  closeCue();

  return cues
    .map(
      (c, i) =>
        `${i + 1}\n${srtTimestamp(c.startMs)} --> ${srtTimestamp(c.endMs)}\n${c.text}\n`
    )
    .join('\n');
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

/** Pixel dimensions of the first video stream, or null if it can't be read */
async function probeVideoSize(mediaPath: string): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      mediaPath,
    ]);
    const [width, height] = stdout.trim().split(',').map((n) => parseInt(n, 10));
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  } catch {
    /* fall through */
  }
  return null;
}

const toSeconds = (ms: number): string => (ms / 1000).toFixed(3);

// The subtitles filter needs an ffmpeg built with libass (present on the dev
// box's Debian ffmpeg; absent from some Homebrew builds). Probe once so a
// caption request on a host without it degrades to an unburned render
// instead of failing the job.
let subtitlesFilterAvailable: boolean | null = null;
export async function canBurnSubtitles(): Promise<boolean> {
  if (subtitlesFilterAvailable === null) {
    try {
      const { stdout } = await execFileAsync(ffmpegPath, ['-hide_banner', '-filters'], {
        maxBuffer: 8 * 1024 * 1024,
      });
      subtitlesFilterAvailable = /\bsubtitles\b/.test(stdout);
    } catch {
      subtitlesFilterAvailable = false;
    }
  }
  return subtitlesFilterAvailable;
}

/**
 * Builds the ffmpeg filter graph: per-segment trim/atrim reset to t=0 with the
 * segment's speed baked in (setpts for video, atempo for audio), then a single
 * concat, then an optional subtitle burn. Written to a script file since the
 * graph grows with segment count and would overflow the argv limit on heavily
 * edited transcripts.
 */
/** Placement of the branded lower-third: which ffmpeg input carries the PNG, and how to scale/time it */
interface LowerThirdOverlay {
  inputIndex: number;
  scaleWidth: number;
  durationSec: number;
}

function buildFilterScript(
  segments: ExportSegment[],
  hasVideo: boolean,
  hasAudio: boolean,
  srtPath?: string | null,
  overlay?: LowerThirdOverlay | null
): { script: string; videoOut: string } {
  const chains: string[] = [];
  const concatInputs: string[] = [];

  segments.forEach((seg, i) => {
    const start = toSeconds(seg.startMs);
    const end = toSeconds(seg.endMs);
    if (hasVideo) {
      const pts =
        seg.speed === 1
          ? 'setpts=PTS-STARTPTS'
          : `setpts=(PTS-STARTPTS)/${seg.speed}`;
      chains.push(`[0:v]trim=start=${start}:end=${end},${pts}[v${i}]`);
      concatInputs.push(`[v${i}]`);
    }
    if (hasAudio) {
      const tempo = seg.speed === 1 ? '' : `,atempo=${seg.speed}`;
      chains.push(
        `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS${tempo}[a${i}]`
      );
      concatInputs.push(`[a${i}]`);
    }
  });

  const outLabels = `${hasVideo ? '[outv]' : ''}${hasAudio ? '[outa]' : ''}`;
  chains.push(
    `${concatInputs.join('')}concat=n=${segments.length}:v=${hasVideo ? 1 : 0}:a=${hasAudio ? 1 : 0}${outLabels}`
  );

  let videoOut = hasVideo ? '[outv]' : '';

  if (srtPath && hasVideo) {
    // No quoting: artipod paths contain no filtergraph metacharacters, and the
    // filter parser rejects quoted values inside a script file
    chains.push(`${videoOut}subtitles=filename=${srtPath}[outvs]`);
    videoOut = '[outvs]';
  }

  if (overlay && hasVideo) {
    // Scale the lower-third PNG to the video width and composite it at the
    // bottom for the opening seconds. shortest=1 ends the render with the main
    // stream (the looped image input is otherwise infinite).
    chains.push(`[${overlay.inputIndex}:v]scale=${overlay.scaleWidth}:-1:flags=lanczos[lt]`);
    chains.push(
      `${videoOut}[lt]overlay=0:H-h:enable='between(t,0,${overlay.durationSec})':shortest=1[outlt]`
    );
    videoOut = '[outlt]';
  }

  return { script: chains.join(';\n'), videoOut };
}

export interface ExportResult {
  filename: string;
  durationMs: number;
}

/**
 * Renders the export plan to a new media file inside the artipod folder.
 * Re-encodes (required for frame-accurate cuts and speed baking); writes to a
 * dotfile first so a failed render never leaves a half-written export where
 * the UI can find it. When srtPath is given (video only) the captions are
 * burned in via the subtitles filter.
 */
// How long the branded lower-third stays on screen at the start of the video
const LOWER_THIRD_DURATION_SEC = 5;

/** Decodes a `data:image/png;base64,...` URL to a temp PNG, or null if malformed */
function writeDataUrlPng(dataUrl: string): string | null {
  const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) return null;
  const path = join(tmpdir(), `pulseclip-lowerthird-${randomUUID()}.png`);
  writeFileSync(path, Buffer.from(match[1], 'base64'));
  return path;
}

export async function renderExport(
  mediaPath: string,
  artipodPath: string,
  plan: ExportPlan,
  srtPath?: string | null,
  lowerThirdDataUrl?: string | null
): Promise<ExportResult> {
  const { segments } = plan;
  if (segments.length === 0) {
    throw new Error('Nothing to export: the edit list has no remaining words');
  }

  const { hasVideo, hasAudio } = await probeStreams(mediaPath);
  if (!hasVideo && !hasAudio) {
    throw new Error('Source file has no audio or video streams');
  }

  const burnSrt = hasVideo ? srtPath : null;
  const filename = hasVideo ? 'export.mp4' : 'export.m4a';
  const scriptPath = join(tmpdir(), `pulseclip-export-${randomUUID()}.filter`);
  const tmpOutPath = join(artipodPath, `.export-tmp-${randomUUID()}${hasVideo ? '.mp4' : '.m4a'}`);

  // The lower-third is overlaid only when there's a video stream and we can
  // read its width to scale to. A bad PNG or unreadable size degrades to a
  // plain export rather than failing the job.
  let lowerThirdPath: string | null = null;
  let overlay: LowerThirdOverlay | null = null;
  if (hasVideo && lowerThirdDataUrl) {
    lowerThirdPath = writeDataUrlPng(lowerThirdDataUrl);
    const size = lowerThirdPath ? await probeVideoSize(mediaPath) : null;
    if (lowerThirdPath && size) {
      overlay = { inputIndex: 1, scaleWidth: size.width, durationSec: LOWER_THIRD_DURATION_SEC };
    } else if (lowerThirdPath) {
      console.warn('Lower-third requested but video size unreadable; rendering without it');
    }
  }

  const { script, videoOut } = buildFilterScript(segments, hasVideo, hasAudio, burnSrt, overlay);
  writeFileSync(scriptPath, script);

  const args = ['-y', '-i', mediaPath];
  // The lower-third PNG is input 1 (matches overlay.inputIndex); looped so it
  // provides frames across the timeline (overlay's shortest=1 bounds the output)
  if (overlay && lowerThirdPath) {
    args.push('-loop', '1', '-i', lowerThirdPath);
  }
  args.push('-filter_complex_script', scriptPath);
  if (hasVideo) {
    args.push('-map', videoOut, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
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
    if (lowerThirdPath) {
      try { unlinkSync(lowerThirdPath); } catch { /* may not exist */ }
    }
  }

  return { filename, durationMs: Math.round(plan.durationMs) };
}
