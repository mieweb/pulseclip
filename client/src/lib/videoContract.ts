/**
 * videoContract — client-side inspection of a picked media file against
 * PulseClip's upload contract.
 *
 * THE CONTRACT (project-wide, every capture/upload path targets it):
 *
 *     H.264 · long edge <= 1920 · <= 5 Mbps · AAC audio · faststart
 *
 * Files that break it are the reason phones stall on playback: a 4K HEVC
 * clip at ~25 Mbps with its index at the end of the file is a slideshow on
 * an iPhone and does not decode at all on Android.
 *
 * This module does DETECTION ONLY — it never re-encodes and never blocks an
 * upload. It reports what is wrong so the UI can warn.
 *
 * Design notes:
 *
 * - Zero dependencies. Everything here is `File`/`DataView`/`<video>`.
 * - Reads are RANGED. The MP4 box walk touches a few hundred bytes plus the
 *   `moov` box itself, never the whole file — these uploads are hundreds of
 *   megabytes.
 * - CRITICAL: these files are NOT faststart, so `moov` sits at the very END.
 *   Scanning the first N bytes finds nothing. We walk the top-level box
 *   chain by size (including the 64-bit `largesize` form, which real 4K
 *   phone recordings DO use for `mdat`) until we reach it, wherever it is.
 * - Nothing throws into the UI. Anything unparseable comes back as
 *   `'unknown'` and simply produces no violation.
 */

/* ------------------------------------------------------------------ */
/* Contract                                                            */
/* ------------------------------------------------------------------ */

export const UPLOAD_CONTRACT = {
  /** Longest edge in pixels (1080p in either orientation). */
  maxLongEdge: 1920,
  /** Overall file bitrate ceiling, bits per second. */
  maxBitrateBps: 5_000_000,
  /**
   * Grace factor applied to the bitrate ceiling before we warn.
   *
   * The contract targets 5 Mbps of *video*; a compliant export also carries
   * ~128 kbps of AAC plus container overhead, so its measured whole-file
   * bitrate lands slightly above 5 Mbps. Without this, PulseClip's own
   * exports would trip their own warning. 15% is comfortably below the
   * ~5x overshoot of an actual phone recording.
   */
  bitrateGrace: 1.15,
  videoCodec: 'H.264',
  audioCodec: 'AAC',
} as const;

/** Bitrate at or below which we stay quiet. */
export const BITRATE_WARN_THRESHOLD_BPS =
  UPLOAD_CONTRACT.maxBitrateBps * UPLOAD_CONTRACT.bitrateGrace;

/**
 * A copy-pasteable fix for someone sitting at a laptop with ffmpeg.
 *
 * The scale filter fits the frame inside a 1920x1920 box rather than
 * capping the width: phone recordings are usually PORTRAIT, and
 * `scale='min(1920,iw)':-2` would turn a 2160x3840 clip into 1920x3414 —
 * taller than the original and still over the ceiling.
 */
export const FFMPEG_FIX_COMMAND =
  'ffmpeg -i input.mp4 ' +
  "-vf \"scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2\" " +
  '-c:v libx264 -b:v 5M -c:a aac -b:a 128k -movflags +faststart output.mp4';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type VideoCodec = 'h264' | 'hevc' | 'other' | 'unknown';
export type AudioCodec = 'aac' | 'other' | 'unknown';
/** Tri-state: we could not always answer, and "don't know" must not warn. */
export type Tristate = boolean | 'unknown';

export interface MediaProbe {
  /** Bytes, straight off the File. */
  sizeBytes: number;
  /** Display width in pixels, or null if we could not determine it. */
  width: number | null;
  height: number | null;
  /** Seconds. */
  durationSeconds: number | null;
  /** Whole-file bitrate in bits per second (size * 8 / duration). */
  bitrateBps: number | null;
  videoCodec: VideoCodec;
  /** Raw sample-entry fourcc, e.g. 'hvc1' — useful in bug reports. */
  videoFourcc: string | null;
  audioCodec: AudioCodec;
  audioFourcc: string | null;
  /** True iff `moov` precedes `mdat` among the top-level boxes. */
  faststart: Tristate;
  /** Whether the file parsed as ISO base media (MP4/MOV). */
  isIsoBmff: boolean;
  /** Where each source of truth came from — handy when debugging. */
  dimensionsFrom: 'video-element' | 'mp4-box' | null;
  durationFrom: 'video-element' | 'mp4-box' | null;
}

export type ViolationCode =
  | 'resolution'
  | 'bitrate'
  | 'faststart'
  | 'videoCodec'
  | 'audioCodec';

export interface ContractViolation {
  code: ViolationCode;
  /** One line, specific, with the real numbers in it. */
  message: string;
  /** What the contract wanted instead. */
  expected: string;
}

export interface ContractReport {
  probe: MediaProbe;
  /** Ordered worst-first. Empty means nothing detectably wrong. */
  violations: ContractViolation[];
  /** True when we found no violations (unknowns do not count as failures). */
  ok: boolean;
  /** One-sentence summary for the top of a warning, or null when ok. */
  headline: string | null;
}

/* ------------------------------------------------------------------ */
/* Byte source — lets the same parser run on a browser File and on a    */
/* Node file handle in tests, without loading 344 MB into memory.       */
/* ------------------------------------------------------------------ */

export interface ByteSource {
  readonly size: number;
  /** Half-open range [start, end). Implementations must clamp to `size`. */
  read(start: number, end: number): Promise<Uint8Array>;
}

/** Wrap a browser `File`/`Blob` as a ByteSource. */
export function blobByteSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(start, end) {
      const from = Math.max(0, Math.min(start, blob.size));
      const to = Math.max(from, Math.min(end, blob.size));
      if (to === from) return new Uint8Array(0);
      const buffer = await blob.slice(from, to).arrayBuffer();
      return new Uint8Array(buffer);
    },
  };
}

/* ------------------------------------------------------------------ */
/* MP4 box walking                                                     */
/* ------------------------------------------------------------------ */

/** Bail out rather than loop forever on a malformed/hostile file. */
const MAX_TOP_LEVEL_BOXES = 4096;
/** `moov` is normally tens of KB. Refuse to buffer something absurd. */
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

export interface TopLevelBox {
  type: string;
  /** Absolute offset of the box header. */
  offset: number;
  /** Total box size including the header. */
  size: number;
  /** 8, or 16 when the 64-bit `largesize` form is used. */
  headerSize: number;
}

export interface Mp4Structure {
  isIsoBmff: boolean;
  topLevelBoxes: TopLevelBox[];
  faststart: Tristate;
  videoFourcc: string | null;
  audioFourcc: string | null;
  /** Pixel dimensions from the video sample entry (pre-rotation). */
  width: number | null;
  height: number | null;
  /** Duration from `mvhd`, in seconds. */
  durationSeconds: number | null;
}

const EMPTY_STRUCTURE: Mp4Structure = {
  isIsoBmff: false,
  topLevelBoxes: [],
  faststart: 'unknown',
  videoFourcc: null,
  audioFourcc: null,
  width: null,
  height: null,
  durationSeconds: null,
};

function fourccAt(bytes: Uint8Array, offset: number): string | null {
  if (offset + 4 > bytes.length) return null;
  let out = '';
  for (let i = offset; i < offset + 4; i++) {
    const code = bytes[i];
    // Box types are printable ASCII (some use 0xA9, e.g. '©too', but never
    // control bytes). Anything else means we are not looking at a box.
    if (code < 0x20 || code > 0x7e) {
      if (code !== 0xa9) return null;
    }
    out += String.fromCharCode(code);
  }
  return out;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Walk the top-level box chain from byte 0, seeking by each box's declared
 * size. This is what finds `moov` at the 100% mark on a non-faststart file.
 */
export async function readTopLevelBoxes(
  source: ByteSource
): Promise<TopLevelBox[]> {
  const boxes: TopLevelBox[] = [];
  let offset = 0;

  for (let guard = 0; guard < MAX_TOP_LEVEL_BOXES; guard++) {
    if (offset + 8 > source.size) break;

    const header = await source.read(offset, Math.min(offset + 16, source.size));
    if (header.length < 8) break;

    const view = viewOf(header);
    let size = view.getUint32(0);
    const type = fourccAt(header, 4);
    if (type === null) break;

    let headerSize = 8;
    if (size === 1) {
      // 64-bit `largesize` — real 4K phone recordings hit this on `mdat`.
      if (header.length < 16) break;
      const large = view.getBigUint64(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) {
      // "extends to end of file"
      size = source.size - offset;
    }

    if (size < headerSize) break; // malformed; refuse to spin
    boxes.push({ type, offset, size, headerSize });
    offset += size;
  }

  return boxes;
}

interface MemBox {
  type: string;
  /** Offset of the box header within the buffer. */
  start: number;
  /** Offset just past the box. */
  end: number;
  /** Offset of the first payload byte. */
  bodyStart: number;
}

/** Enumerate the direct children of an already-buffered container box. */
function childBoxes(bytes: Uint8Array, start: number, end: number): MemBox[] {
  const out: MemBox[] = [];
  const view = viewOf(bytes);
  let offset = start;

  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = fourccAt(bytes, offset + 4);
    if (type === null) break;

    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      const large = view.getBigUint64(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) break;
    out.push({
      type,
      start: offset,
      end: offset + size,
      bodyStart: offset + headerSize,
    });
    offset += size;
  }

  return out;
}

function findChild(
  bytes: Uint8Array,
  parent: MemBox,
  type: string
): MemBox | null {
  return (
    childBoxes(bytes, parent.bodyStart, parent.end).find(
      (b) => b.type === type
    ) ?? null
  );
}

/** Descend a chain of single-child container boxes, e.g. mdia>minf>stbl. */
function findPath(
  bytes: Uint8Array,
  parent: MemBox,
  path: string[]
): MemBox | null {
  let node: MemBox | null = parent;
  for (const type of path) {
    if (!node) return null;
    node = findChild(bytes, node, type);
  }
  return node;
}

/** `hdlr` handler_type: 'vide' for video traks, 'soun' for audio. */
function readHandlerType(bytes: Uint8Array, hdlr: MemBox): string | null {
  // FullBox(4) + pre_defined(4), then handler_type.
  const at = hdlr.bodyStart + 8;
  if (at + 4 > hdlr.end) return null;
  return fourccAt(bytes, at);
}

/** First sample entry of an `stsd`: its fourcc plus, for video, w/h. */
function readSampleEntry(
  bytes: Uint8Array,
  stsd: MemBox
): { fourcc: string; entry: MemBox } | null {
  // FullBox(4) + entry_count(4), then the entries.
  const entriesStart = stsd.bodyStart + 8;
  if (entriesStart + 8 > stsd.end) return null;
  const entries = childBoxes(bytes, entriesStart, stsd.end);
  const first = entries[0];
  if (!first) return null;
  return { fourcc: first.type, entry: first };
}

/**
 * VisualSampleEntry pixel dimensions.
 *
 * Layout after the 8-byte box header: SampleEntry adds reserved(6) +
 * data_reference_index(2) = 8; VisualSampleEntry then adds pre_defined(2) +
 * reserved(2) + pre_defined[3](12) = 16. So width sits 24 bytes into the
 * body and height 2 bytes after it.
 */
function readVisualDimensions(
  bytes: Uint8Array,
  entry: MemBox
): { width: number; height: number } | null {
  const at = entry.bodyStart + 24;
  if (at + 4 > entry.end) return null;
  const view = viewOf(bytes);
  const width = view.getUint16(at);
  const height = view.getUint16(at + 2);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/** `mvhd` duration / timescale, in seconds. */
function readMovieDuration(bytes: Uint8Array, mvhd: MemBox): number | null {
  const view = viewOf(bytes);
  const version = bytes[mvhd.bodyStart];
  let timescale: number;
  let duration: number;

  if (version === 1) {
    // creation(8) modification(8) timescale(4) duration(8)
    if (mvhd.bodyStart + 28 > mvhd.end) return null;
    timescale = view.getUint32(mvhd.bodyStart + 20);
    const raw = view.getBigUint64(mvhd.bodyStart + 24);
    if (raw > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    duration = Number(raw);
  } else {
    // creation(4) modification(4) timescale(4) duration(4)
    if (mvhd.bodyStart + 20 > mvhd.end) return null;
    timescale = view.getUint32(mvhd.bodyStart + 12);
    duration = view.getUint32(mvhd.bodyStart + 16);
  }

  if (!timescale || !duration) return null;
  const seconds = duration / timescale;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Parse enough of an MP4/MOV to answer the contract questions.
 *
 * Never throws: an unparseable file returns `EMPTY_STRUCTURE`.
 */
export async function parseMp4Structure(
  source: ByteSource
): Promise<Mp4Structure> {
  try {
    const topLevelBoxes = await readTopLevelBoxes(source);
    if (topLevelBoxes.length === 0) return EMPTY_STRUCTURE;

    // Every ISO base media file opens with `ftyp`. Without it we are looking
    // at something else (WebM, raw audio, a renamed .txt) and must not
    // pretend the byte offsets mean anything.
    if (topLevelBoxes[0].type !== 'ftyp') return EMPTY_STRUCTURE;

    const moov = topLevelBoxes.find((b) => b.type === 'moov') ?? null;
    const mdat = topLevelBoxes.find((b) => b.type === 'mdat') ?? null;

    const faststart: Tristate =
      moov && mdat ? moov.offset < mdat.offset : 'unknown';

    const result: Mp4Structure = {
      ...EMPTY_STRUCTURE,
      isIsoBmff: true,
      topLevelBoxes,
      faststart,
    };

    if (!moov || moov.size > MAX_MOOV_BYTES) return result;

    // Buffer just the moov box (tens of KB even for a 344 MB recording).
    const bytes = await source.read(moov.offset, moov.offset + moov.size);
    if (bytes.length < moov.headerSize) return result;

    const root: MemBox = {
      type: 'moov',
      start: 0,
      end: bytes.length,
      bodyStart: moov.headerSize,
    };

    const mvhd = findChild(bytes, root, 'mvhd');
    if (mvhd) result.durationSeconds = readMovieDuration(bytes, mvhd);

    for (const trak of childBoxes(bytes, root.bodyStart, root.end)) {
      if (trak.type !== 'trak') continue;

      const mdia = findChild(bytes, trak, 'mdia');
      if (!mdia) continue;

      const hdlr = findChild(bytes, mdia, 'hdlr');
      const handler = hdlr ? readHandlerType(bytes, hdlr) : null;
      if (handler !== 'vide' && handler !== 'soun') continue;

      const stsd = findPath(bytes, mdia, ['minf', 'stbl', 'stsd']);
      if (!stsd) continue;

      const sample = readSampleEntry(bytes, stsd);
      if (!sample) continue;

      if (handler === 'vide' && !result.videoFourcc) {
        result.videoFourcc = sample.fourcc;
        const dims = readVisualDimensions(bytes, sample.entry);
        if (dims) {
          result.width = dims.width;
          result.height = dims.height;
        }
      } else if (handler === 'soun' && !result.audioFourcc) {
        result.audioFourcc = sample.fourcc;
      }
    }

    return result;
  } catch {
    // A truncated or hostile file must never take the upload UI down.
    return EMPTY_STRUCTURE;
  }
}

/* ------------------------------------------------------------------ */
/* Codec mapping                                                       */
/* ------------------------------------------------------------------ */

const H264_FOURCCS = ['avc1', 'avc3'];
const HEVC_FOURCCS = ['hvc1', 'hev1', 'hvc2', 'hev2', 'dvh1', 'dvhe'];

export function classifyVideoFourcc(fourcc: string | null): VideoCodec {
  if (!fourcc) return 'unknown';
  const key = fourcc.toLowerCase();
  if (H264_FOURCCS.includes(key)) return 'h264';
  if (HEVC_FOURCCS.includes(key)) return 'hevc';
  return 'other';
}

export function classifyAudioFourcc(fourcc: string | null): AudioCodec {
  if (!fourcc) return 'unknown';
  const key = fourcc.toLowerCase();
  // `mp4a` is MPEG-4 audio; in practice from any camera or encoder we care
  // about that means AAC. Distinguishing further needs the `esds`
  // objectTypeIndication, which is not worth it for a warning.
  if (key === 'mp4a') return 'aac';
  return 'other';
}

/* ------------------------------------------------------------------ */
/* Contract evaluation (pure — this is the part worth unit testing)     */
/* ------------------------------------------------------------------ */

function formatMbps(bps: number): string {
  return `${(bps / 1_000_000).toFixed(1)} Mbps`;
}

/**
 * Decide which contract rules a probe violates.
 *
 * Ordered worst-first by how much each one actually hurts phone playback:
 * pixels dominate, then bitrate, then the tail-placed index, then codec
 * (which is an Android-only hard failure — iPhone Safari decodes HEVC).
 */
export function evaluateContract(probe: MediaProbe): ContractViolation[] {
  const violations: ContractViolation[] = [];

  if (probe.width !== null && probe.height !== null) {
    const longEdge = Math.max(probe.width, probe.height);
    if (longEdge > UPLOAD_CONTRACT.maxLongEdge) {
      // Decode cost scales with pixel count, so quote the area ratio — but
      // only when it rounds to something meaningful (4K is a clean 4x).
      const areaRatio = Math.round((longEdge / UPLOAD_CONTRACT.maxLongEdge) ** 2);
      violations.push({
        code: 'resolution',
        message:
          areaRatio >= 2
            ? `This video is ${probe.width}x${probe.height} — ${areaRatio}x more pixels than phones can comfortably decode.`
            : `This video is ${probe.width}x${probe.height}, above the 1080p ceiling phones decode comfortably.`,
        expected: `long edge ${UPLOAD_CONTRACT.maxLongEdge}px or less (1080p)`,
      });
    }
  }

  if (probe.bitrateBps !== null && probe.bitrateBps > BITRATE_WARN_THRESHOLD_BPS) {
    violations.push({
      code: 'bitrate',
      message: `It runs at ${formatMbps(
        probe.bitrateBps
      )}, well over what a phone can pull and decode smoothly.`,
      expected: `${formatMbps(UPLOAD_CONTRACT.maxBitrateBps)} or less`,
    });
  }

  if (probe.faststart === false) {
    violations.push({
      code: 'faststart',
      message:
        'Its index sits at the end of the file, so playback cannot start until almost all of it has downloaded.',
      expected: 'faststart (index moved to the front)',
    });
  }

  if (probe.videoCodec === 'hevc') {
    violations.push({
      code: 'videoCodec',
      message: `The video is HEVC/H.265 (${
        probe.videoFourcc ?? 'hvc1'
      }), which Android browsers cannot play at all.`,
      expected: `${UPLOAD_CONTRACT.videoCodec} (avc1)`,
    });
  } else if (probe.videoCodec === 'other') {
    violations.push({
      code: 'videoCodec',
      message: `The video codec (${
        probe.videoFourcc ?? 'unknown'
      }) is not H.264, so some browsers will refuse to play it.`,
      expected: `${UPLOAD_CONTRACT.videoCodec} (avc1)`,
    });
  }

  if (probe.audioCodec === 'other') {
    violations.push({
      code: 'audioCodec',
      message: `The audio track (${
        probe.audioFourcc ?? 'unknown'
      }) is not AAC, which some browsers will not decode.`,
      expected: UPLOAD_CONTRACT.audioCodec,
    });
  }

  return violations;
}

/** One sentence leading with the numbers that matter most. */
export function buildHeadline(probe: MediaProbe, violations: ContractViolation[]): string | null {
  if (violations.length === 0) return null;

  const facts: string[] = [];
  if (probe.width !== null && probe.height !== null) {
    facts.push(`${probe.width}x${probe.height}`);
  }
  if (probe.bitrateBps !== null) {
    facts.push(formatMbps(probe.bitrateBps));
  }
  if (facts.length === 0 && probe.videoCodec === 'hevc') {
    facts.push('HEVC');
  }

  return facts.length > 0
    ? `This is ${facts.join(' at ')} — phones will struggle to play it.`
    : 'This file does not match PulseClip playback settings — phones may struggle to play it.';
}

/* ------------------------------------------------------------------ */
/* Browser probing                                                     */
/* ------------------------------------------------------------------ */

/** How long to wait on the browser for metadata before giving up. */
const VIDEO_METADATA_TIMEOUT_MS = 15_000;

export interface ElementMetadata {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

/**
 * Load the file into a detached `<video>` and read its metadata.
 *
 * Resolves with nulls rather than rejecting — a browser that cannot decode
 * the file (Android + HEVC, which is exactly the case we warn about) still
 * needs to reach the MP4 fallbacks. Always revokes the object URL.
 */
export function probeWithVideoElement(
  file: Blob,
  timeoutMs: number = VIDEO_METADATA_TIMEOUT_MS
): Promise<ElementMetadata> {
  const empty: ElementMetadata = {
    width: null,
    height: null,
    durationSeconds: null,
  };

  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return Promise.resolve(empty);
  }

  return new Promise<ElementMetadata>((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;

    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      // Detach the source before revoking so the element stops reading.
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };

    const finish = (result: ElementMetadata) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    function onLoaded() {
      const duration = Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : null;
      finish({
        width: video.videoWidth || null,
        height: video.videoHeight || null,
        durationSeconds: duration,
      });
    }

    function onError() {
      finish(empty);
    }

    const timer = window.setTimeout(() => finish(empty), timeoutMs);

    video.preload = 'metadata';
    video.muted = true;
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
    video.src = url;
  });
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Assemble a probe from whatever each source could answer.
 *
 * The `<video>` element is preferred for dimensions and duration (it applies
 * the rotation matrix and reports what will actually be displayed); the MP4
 * boxes fill in whenever the browser could not decode the file at all.
 */
export function combineProbe(
  sizeBytes: number,
  element: ElementMetadata,
  structure: Mp4Structure
): MediaProbe {
  const useElementDims = element.width !== null && element.height !== null;
  const width = useElementDims ? element.width : structure.width;
  const height = useElementDims ? element.height : structure.height;

  const durationSeconds =
    element.durationSeconds ?? structure.durationSeconds ?? null;

  const bitrateBps =
    durationSeconds !== null && durationSeconds > 0
      ? (sizeBytes * 8) / durationSeconds
      : null;

  return {
    sizeBytes,
    width,
    height,
    durationSeconds,
    bitrateBps,
    videoCodec: classifyVideoFourcc(structure.videoFourcc),
    videoFourcc: structure.videoFourcc,
    audioCodec: classifyAudioFourcc(structure.audioFourcc),
    audioFourcc: structure.audioFourcc,
    faststart: structure.faststart,
    isIsoBmff: structure.isIsoBmff,
    dimensionsFrom: useElementDims
      ? 'video-element'
      : structure.width !== null
        ? 'mp4-box'
        : null,
    durationFrom:
      element.durationSeconds !== null
        ? 'video-element'
        : structure.durationSeconds !== null
          ? 'mp4-box'
          : null,
  };
}

/** Turn a probe into the full report. */
export function reportFromProbe(probe: MediaProbe): ContractReport {
  const violations = evaluateContract(probe);
  return {
    probe,
    violations,
    ok: violations.length === 0,
    headline: buildHeadline(probe, violations),
  };
}

/**
 * Inspect a picked file against the upload contract.
 *
 * Safe to call on anything the user drops — audio, a PDF, a zero-byte file.
 * Never throws; unanswerable questions come back as `null`/`'unknown'` and
 * produce no violation.
 */
export async function inspectMediaFile(file: File): Promise<ContractReport> {
  const isVideo =
    file.type.startsWith('video/') || /\.(mp4|mov|m4v|qt)$/i.test(file.name);

  // Audio uploads are legitimate and have no resolution/codec contract.
  if (!isVideo && file.type.startsWith('audio/')) {
    return reportFromProbe(
      combineProbe(file.size, { width: null, height: null, durationSeconds: null }, {
        ...EMPTY_STRUCTURE,
      })
    );
  }

  const [element, structure] = await Promise.all([
    probeWithVideoElement(file),
    parseMp4Structure(blobByteSource(file)),
  ]);

  return reportFromProbe(combineProbe(file.size, element, structure));
}
