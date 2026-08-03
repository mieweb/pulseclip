/**
 * Tests for the upload-contract inspector.
 *
 * Runs on Node's built-in test runner (`node --test`, no dependencies).
 * The MP4 parser is written against a `ByteSource` rather than a browser
 * `File` precisely so it can be driven here — both from hand-built byte
 * arrays and, when present, from the real 344 MB non-faststart 4K HEVC
 * recording that motivated this work.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { stat } from 'node:fs/promises';

import {
  BITRATE_WARN_THRESHOLD_BPS,
  UPLOAD_CONTRACT,
  blobByteSource,
  buildHeadline,
  classifyAudioFourcc,
  classifyVideoFourcc,
  combineProbe,
  evaluateContract,
  parseMp4Structure,
  readTopLevelBoxes,
  reportFromProbe,
  type ByteSource,
  type MediaProbe,
  type Mp4Structure,
} from '../src/lib/videoContract.ts';

/* ------------------------------------------------------------------ */
/* Helpers: build synthetic MP4 byte streams                           */
/* ------------------------------------------------------------------ */

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

/** Standard 8-byte-header box. */
function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(body.length + 8), ascii(type), body]);
}

/** 64-bit `largesize` box (size field == 1, 16-byte header). */
function largeBox(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(1), ascii(type), u64(body.length + 16), body]);
}

const ftyp = () => box('ftyp', ascii('isom'), u32(512), ascii('isomiso2'));

function mvhd(timescale: number, duration: number): Uint8Array {
  return box(
    'mvhd',
    u32(0), // version 0 + flags
    u32(0), // creation
    u32(0), // modification
    u32(timescale),
    u32(duration),
    new Uint8Array(80) // the rest, unread
  );
}

function mvhdV1(timescale: number, duration: number): Uint8Array {
  return box(
    'mvhd',
    new Uint8Array([1, 0, 0, 0]), // version 1 + flags
    u64(0), // creation
    u64(0), // modification
    u32(timescale),
    u64(duration),
    new Uint8Array(80)
  );
}

function hdlr(handlerType: string): Uint8Array {
  return box(
    'hdlr',
    u32(0), // version + flags
    u32(0), // pre_defined
    ascii(handlerType),
    new Uint8Array(12), // reserved
    new Uint8Array([0]) // empty name
  );
}

/** VisualSampleEntry: width/height live 24 bytes into the body. */
function visualSampleEntry(fourcc: string, width: number, height: number): Uint8Array {
  return box(
    fourcc,
    new Uint8Array(6), // reserved
    u16(1), // data_reference_index
    u16(0), // pre_defined
    u16(0), // reserved
    new Uint8Array(12), // pre_defined[3]
    u16(width),
    u16(height),
    new Uint8Array(50) // horizresolution onwards, unread
  );
}

function audioSampleEntry(fourcc: string): Uint8Array {
  return box(fourcc, new Uint8Array(6), u16(1), new Uint8Array(20));
}

function stsd(entry: Uint8Array): Uint8Array {
  return box('stsd', u32(0), u32(1), entry);
}

function trak(handlerType: string, entry: Uint8Array): Uint8Array {
  return box(
    'trak',
    box('tkhd', u32(0), new Uint8Array(80)),
    box('mdia', hdlr(handlerType), box('minf', box('stbl', stsd(entry))))
  );
}

interface MoovOptions {
  videoFourcc?: string | null;
  width?: number;
  height?: number;
  audioFourcc?: string | null;
  timescale?: number;
  duration?: number;
  v1Header?: boolean;
}

function moov(options: MoovOptions = {}): Uint8Array {
  const {
    videoFourcc = 'avc1',
    width = 1920,
    height = 1080,
    audioFourcc = 'mp4a',
    timescale = 1000,
    duration = 60_000,
    v1Header = false,
  } = options;

  const parts: Uint8Array[] = [
    v1Header ? mvhdV1(timescale, duration) : mvhd(timescale, duration),
  ];
  if (videoFourcc) {
    parts.push(trak('vide', visualSampleEntry(videoFourcc, width, height)));
  }
  if (audioFourcc) {
    parts.push(trak('soun', audioSampleEntry(audioFourcc)));
  }
  return box('moov', ...parts);
}

function mdat(byteLength: number): Uint8Array {
  return box('mdat', new Uint8Array(byteLength));
}

/** ByteSource over an in-memory buffer (mirrors what `blobByteSource` does). */
function bufferSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(start, end) {
      const from = Math.max(0, Math.min(start, bytes.length));
      const to = Math.max(from, Math.min(end, bytes.length));
      return bytes.slice(from, to);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Top-level box walking                                               */
/* ------------------------------------------------------------------ */

test('walks the top-level box chain in order', async () => {
  const bytes = concat([ftyp(), mdat(100), moov()]);
  const boxes = await readTopLevelBoxes(bufferSource(bytes));
  assert.deepEqual(
    boxes.map((b) => b.type),
    ['ftyp', 'mdat', 'moov']
  );
  assert.equal(boxes[0].offset, 0);
  assert.equal(boxes[1].offset, ftyp().length);
});

test('finds moov even when it sits at the very end of the file', async () => {
  // The case that breaks a naive "scan the first N bytes" parser: a huge
  // mdat with the index behind it.
  const bytes = concat([ftyp(), mdat(500_000), moov()]);
  const structure = await parseMp4Structure(bufferSource(bytes));

  assert.equal(structure.isIsoBmff, true);
  assert.equal(structure.videoFourcc, 'avc1');
  const moovBox = structure.topLevelBoxes.find((b) => b.type === 'moov')!;
  assert.ok(
    moovBox.offset / bytes.length > 0.99,
    'moov should be at the tail of the file'
  );
});

test('handles the 64-bit largesize header form', async () => {
  const bytes = concat([ftyp(), largeBox('mdat', new Uint8Array(300)), moov()]);
  const boxes = await readTopLevelBoxes(bufferSource(bytes));

  assert.deepEqual(
    boxes.map((b) => b.type),
    ['ftyp', 'mdat', 'moov']
  );
  assert.equal(boxes[1].headerSize, 16);
  assert.equal(boxes[1].size, 316);

  const structure = await parseMp4Structure(bufferSource(bytes));
  assert.equal(structure.videoFourcc, 'avc1');
  assert.equal(structure.faststart, false);
});

test('handles size==0 meaning "extends to end of file"', async () => {
  const openEnded = concat([u32(0), ascii('mdat'), new Uint8Array(64)]);
  const bytes = concat([ftyp(), openEnded]);
  const boxes = await readTopLevelBoxes(bufferSource(bytes));

  assert.deepEqual(
    boxes.map((b) => b.type),
    ['ftyp', 'mdat']
  );
  assert.equal(boxes[1].size, openEnded.length);
});

test('stops rather than looping on a malformed box size', async () => {
  // A declared size of 2 is smaller than the 8-byte header: advancing by it
  // would spin forever.
  const bogus = concat([u32(2), ascii('junk'), new Uint8Array(32)]);
  const bytes = concat([ftyp(), bogus]);
  const boxes = await readTopLevelBoxes(bufferSource(bytes));
  assert.deepEqual(
    boxes.map((b) => b.type),
    ['ftyp']
  );
});

/* ------------------------------------------------------------------ */
/* faststart                                                           */
/* ------------------------------------------------------------------ */

test('faststart is true when moov precedes mdat', async () => {
  const structure = await parseMp4Structure(
    bufferSource(concat([ftyp(), moov(), mdat(200)]))
  );
  assert.equal(structure.faststart, true);
});

test('faststart is false when mdat precedes moov', async () => {
  const structure = await parseMp4Structure(
    bufferSource(concat([ftyp(), mdat(200), moov()]))
  );
  assert.equal(structure.faststart, false);
});

test('faststart is unknown when there is no mdat to compare against', async () => {
  const structure = await parseMp4Structure(bufferSource(concat([ftyp(), moov()])));
  assert.equal(structure.faststart, 'unknown');
});

/* ------------------------------------------------------------------ */
/* Codecs and dimensions from the boxes                                */
/* ------------------------------------------------------------------ */

test('reads HEVC video and AAC audio fourccs', async () => {
  const bytes = concat([
    ftyp(),
    mdat(1000),
    moov({ videoFourcc: 'hvc1', width: 3840, height: 2160 }),
  ]);
  const structure = await parseMp4Structure(bufferSource(bytes));

  assert.equal(structure.videoFourcc, 'hvc1');
  assert.equal(structure.audioFourcc, 'mp4a');
  assert.equal(structure.width, 3840);
  assert.equal(structure.height, 2160);
});

test('reads duration from a version-0 mvhd', async () => {
  const bytes = concat([ftyp(), moov({ timescale: 600, duration: 66_000 }), mdat(10)]);
  const structure = await parseMp4Structure(bufferSource(bytes));
  assert.equal(structure.durationSeconds, 110);
});

test('reads duration from a version-1 mvhd', async () => {
  const bytes = concat([
    ftyp(),
    moov({ timescale: 1000, duration: 110_588, v1Header: true }),
    mdat(10),
  ]);
  const structure = await parseMp4Structure(bufferSource(bytes));
  assert.equal(structure.durationSeconds, 110.588);
});

test('an audio-only file reports no video track', async () => {
  const bytes = concat([ftyp(), mdat(50), moov({ videoFourcc: null })]);
  const structure = await parseMp4Structure(bufferSource(bytes));
  assert.equal(structure.videoFourcc, null);
  assert.equal(structure.audioFourcc, 'mp4a');
});

/* ------------------------------------------------------------------ */
/* Graceful failure                                                    */
/* ------------------------------------------------------------------ */

test('non-MP4 bytes parse to "unknown" without throwing', async () => {
  const structure = await parseMp4Structure(
    bufferSource(ascii('this is definitely not an mp4 file at all'))
  );
  assert.equal(structure.isIsoBmff, false);
  assert.equal(structure.faststart, 'unknown');
  assert.equal(structure.videoFourcc, null);
});

test('an empty file parses to "unknown" without throwing', async () => {
  const structure = await parseMp4Structure(bufferSource(new Uint8Array(0)));
  assert.equal(structure.isIsoBmff, false);
});

test('a partly truncated moov still recovers the tracks it can read', async () => {
  // Losing the tail clips the audio trak; the video trak in front of it is
  // intact, so the parser reports it rather than giving up on the file.
  const full = concat([ftyp(), mdat(100), moov()]);
  const truncated = full.slice(0, full.length - 40);
  const structure = await parseMp4Structure(bufferSource(truncated));

  assert.equal(structure.isIsoBmff, true);
  assert.equal(structure.faststart, false);
  assert.equal(structure.videoFourcc, 'avc1');
  assert.equal(structure.audioFourcc, null);
});

test('a severely truncated moov degrades to unknown instead of throwing', async () => {
  const head = concat([ftyp(), mdat(100)]);
  // Keep only the moov header plus its mvhd: every trak is gone.
  const truncated = concat([head, moov()]).slice(
    0,
    head.length + 8 + mvhd(1000, 60_000).length
  );
  const structure = await parseMp4Structure(bufferSource(truncated));

  assert.equal(structure.isIsoBmff, true);
  assert.equal(structure.faststart, false);
  assert.equal(structure.videoFourcc, null);
  assert.equal(structure.audioFourcc, null);
  assert.equal(structure.durationSeconds, 60);
});

test('a WebM-style file is not mistaken for ISO base media', async () => {
  const ebml = concat([
    new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
    new Uint8Array(64),
  ]);
  const structure = await parseMp4Structure(bufferSource(ebml));
  assert.equal(structure.isIsoBmff, false);
});

/* ------------------------------------------------------------------ */
/* blobByteSource                                                      */
/* ------------------------------------------------------------------ */

test('blobByteSource reads ranges and clamps past the end', async () => {
  const bytes = concat([ftyp(), mdat(64), moov()]);
  const source = blobByteSource(new Blob([bytes]));

  assert.equal(source.size, bytes.length);
  assert.deepEqual(Array.from(await source.read(0, 4)), Array.from(bytes.slice(0, 4)));
  assert.equal((await source.read(bytes.length - 2, bytes.length + 500)).length, 2);
  assert.equal((await source.read(bytes.length + 10, bytes.length + 20)).length, 0);

  const structure = await parseMp4Structure(source);
  assert.equal(structure.faststart, false);
  assert.equal(structure.videoFourcc, 'avc1');
});

/* ------------------------------------------------------------------ */
/* Codec classification                                                */
/* ------------------------------------------------------------------ */

test('classifies video fourccs', () => {
  assert.equal(classifyVideoFourcc('avc1'), 'h264');
  assert.equal(classifyVideoFourcc('avc3'), 'h264');
  assert.equal(classifyVideoFourcc('hvc1'), 'hevc');
  assert.equal(classifyVideoFourcc('hev1'), 'hevc');
  assert.equal(classifyVideoFourcc('vp09'), 'other');
  assert.equal(classifyVideoFourcc(null), 'unknown');
});

test('classifies audio fourccs', () => {
  assert.equal(classifyAudioFourcc('mp4a'), 'aac');
  assert.equal(classifyAudioFourcc('ac-3'), 'other');
  assert.equal(classifyAudioFourcc(null), 'unknown');
});

/* ------------------------------------------------------------------ */
/* Contract evaluation                                                 */
/* ------------------------------------------------------------------ */

function probe(overrides: Partial<MediaProbe> = {}): MediaProbe {
  return {
    sizeBytes: 10_000_000,
    width: 1920,
    height: 1080,
    durationSeconds: 60,
    bitrateBps: 4_000_000,
    videoCodec: 'h264',
    videoFourcc: 'avc1',
    audioCodec: 'aac',
    audioFourcc: 'mp4a',
    faststart: true,
    isIsoBmff: true,
    dimensionsFrom: 'video-element',
    durationFrom: 'video-element',
    ...overrides,
  };
}

function codes(p: MediaProbe): string[] {
  return evaluateContract(p).map((v) => v.code);
}

test('a compliant file produces no violations', () => {
  assert.deepEqual(codes(probe()), []);
  assert.equal(reportFromProbe(probe()).ok, true);
  assert.equal(reportFromProbe(probe()).headline, null);
});

test('a portrait 1080x1920 file is compliant (long edge, not width)', () => {
  assert.deepEqual(codes(probe({ width: 1080, height: 1920 })), []);
});

test('flags resolution above the long-edge ceiling in either orientation', () => {
  assert.deepEqual(codes(probe({ width: 3840, height: 2160 })), ['resolution']);
  assert.deepEqual(codes(probe({ width: 2160, height: 3840 })), ['resolution']);
});

test('quotes the pixel-area multiple for 4K', () => {
  const [violation] = evaluateContract(probe({ width: 3840, height: 2160 }));
  assert.match(violation.message, /3840x2160/);
  assert.match(violation.message, /4x more pixels/);
});

test('flags bitrate only above the documented grace threshold', () => {
  assert.deepEqual(codes(probe({ bitrateBps: UPLOAD_CONTRACT.maxBitrateBps })), []);
  // A compliant export overshoots slightly with its audio track; stay quiet.
  assert.deepEqual(codes(probe({ bitrateBps: 5_400_000 })), []);
  assert.deepEqual(codes(probe({ bitrateBps: BITRATE_WARN_THRESHOLD_BPS + 1 })), [
    'bitrate',
  ]);
  assert.deepEqual(codes(probe({ bitrateBps: 23_000_000 })), ['bitrate']);
});

test('flags a tail-placed index', () => {
  assert.deepEqual(codes(probe({ faststart: false })), ['faststart']);
  assert.deepEqual(codes(probe({ faststart: 'unknown' })), []);
});

test('flags HEVC and other non-H.264 codecs', () => {
  assert.deepEqual(codes(probe({ videoCodec: 'hevc', videoFourcc: 'hvc1' })), [
    'videoCodec',
  ]);
  assert.deepEqual(codes(probe({ videoCodec: 'other', videoFourcc: 'vp09' })), [
    'videoCodec',
  ]);
  assert.deepEqual(codes(probe({ videoCodec: 'unknown', videoFourcc: null })), []);
});

test('names Android specifically for HEVC', () => {
  const [violation] = evaluateContract(probe({ videoCodec: 'hevc', videoFourcc: 'hvc1' }));
  assert.match(violation.message, /Android/);
  assert.match(violation.message, /hvc1/);
});

test('flags non-AAC audio but stays quiet on unknown audio', () => {
  assert.deepEqual(codes(probe({ audioCodec: 'other', audioFourcc: 'ac-3' })), [
    'audioCodec',
  ]);
  assert.deepEqual(codes(probe({ audioCodec: 'unknown', audioFourcc: null })), []);
});

test('a probe that answered nothing produces no violations', () => {
  assert.deepEqual(
    codes(
      probe({
        width: null,
        height: null,
        durationSeconds: null,
        bitrateBps: null,
        videoCodec: 'unknown',
        videoFourcc: null,
        audioCodec: 'unknown',
        audioFourcc: null,
        faststart: 'unknown',
        isIsoBmff: false,
      })
    ),
    []
  );
});

test('orders violations worst-first: pixels, bitrate, index, codec', () => {
  assert.deepEqual(
    codes(
      probe({
        width: 3840,
        height: 2160,
        bitrateBps: 24_800_000,
        faststart: false,
        videoCodec: 'hevc',
        videoFourcc: 'hvc1',
        audioCodec: 'other',
        audioFourcc: 'ac-3',
      })
    ),
    ['resolution', 'bitrate', 'faststart', 'videoCodec', 'audioCodec']
  );
});

test('headline leads with the resolution and bitrate', () => {
  const p = probe({ width: 3840, height: 2160, bitrateBps: 24_865_367 });
  const headline = buildHeadline(p, evaluateContract(p));
  assert.equal(headline, 'This is 3840x2160 at 24.9 Mbps — phones will struggle to play it.');
});

test('headline falls back when the numbers are unknown', () => {
  const p = probe({
    width: null,
    height: null,
    bitrateBps: null,
    videoCodec: 'hevc',
    videoFourcc: 'hvc1',
  });
  assert.match(buildHeadline(p, evaluateContract(p))!, /HEVC/);
});

/* ------------------------------------------------------------------ */
/* combineProbe                                                        */
/* ------------------------------------------------------------------ */

const emptyElement = { width: null, height: null, durationSeconds: null };

function structure(overrides: Partial<Mp4Structure> = {}): Mp4Structure {
  return {
    isIsoBmff: true,
    topLevelBoxes: [],
    faststart: false,
    videoFourcc: 'hvc1',
    audioFourcc: 'mp4a',
    width: 3840,
    height: 2160,
    durationSeconds: 110.588,
    ...overrides,
  };
}

test('prefers the video element for dimensions and duration', () => {
  const p = combineProbe(
    100,
    { width: 1920, height: 1080, durationSeconds: 10 },
    structure()
  );
  assert.equal(p.width, 1920);
  assert.equal(p.height, 1080);
  assert.equal(p.durationSeconds, 10);
  assert.equal(p.dimensionsFrom, 'video-element');
  assert.equal(p.durationFrom, 'video-element');
});

test('falls back to the MP4 boxes when the browser cannot decode the file', () => {
  // Android + HEVC: loadedmetadata never fires, but we still know everything
  // that matters from the boxes.
  const p = combineProbe(343_727_447, emptyElement, structure());
  assert.equal(p.width, 3840);
  assert.equal(p.height, 2160);
  assert.equal(p.dimensionsFrom, 'mp4-box');
  assert.equal(p.durationFrom, 'mp4-box');
  assert.equal(p.videoCodec, 'hevc');
  assert.equal(p.faststart, false);
  assert.ok(Math.abs(p.bitrateBps! - 24_865_367) < 1000);
});

test('bitrate is null when duration is unavailable', () => {
  const p = combineProbe(
    1_000_000,
    emptyElement,
    structure({ durationSeconds: null })
  );
  assert.equal(p.durationSeconds, null);
  assert.equal(p.bitrateBps, null);
  assert.deepEqual(
    evaluateContract(p).map((v) => v.code),
    ['resolution', 'faststart', 'videoCodec']
  );
});

/* ------------------------------------------------------------------ */
/* The real thing                                                      */
/* ------------------------------------------------------------------ */

/**
 * Optional integration test against a real non-faststart 4K HEVC recording.
 *
 * Set PULSECLIP_TEST_MP4 to a local copy (the file is far too big to commit).
 * A known-good sample lives on the dev box at
 * ~/pulseclip-app/shared/artipods/804ddc37-.../669b7a78-....mp4
 */
const realFile = process.env.PULSECLIP_TEST_MP4;
/**
 * Negative control: the same clip re-encoded to the contract with
 * FFMPEG_FIX_COMMAND. Set PULSECLIP_TEST_MP4_COMPLIANT to a local copy.
 */
const compliantFile = process.env.PULSECLIP_TEST_MP4_COMPLIANT;

/** Ranged reads off a file handle — a 344 MB file never lands in memory,
 *  exactly like File.slice() does in the browser. */
async function fileSource(path: string): Promise<{ source: ByteSource; size: number; close: () => Promise<void> }> {
  const info = await stat(path);
  const handle = await open(path, 'r');
  return {
    size: info.size,
    close: () => handle.close(),
    source: {
      size: info.size,
      async read(start, end) {
        const from = Math.max(0, Math.min(start, info.size));
        const to = Math.max(from, Math.min(end, info.size));
        if (to === from) return new Uint8Array(0);
        const buffer = new Uint8Array(to - from);
        await handle.read(buffer, 0, to - from, from);
        return buffer;
      },
    },
  };
}

test('parses a real non-faststart 4K HEVC recording', { skip: !realFile }, async () => {
  const { source, size, close } = await fileSource(realFile!);
  const info = { size };

  try {
    const parsed = await parseMp4Structure(source);
    assert.equal(parsed.isIsoBmff, true);
    assert.equal(parsed.faststart, false, 'moov must be behind mdat');
    assert.equal(parsed.videoFourcc, 'hvc1');
    assert.equal(parsed.audioFourcc, 'mp4a');
    assert.equal(parsed.width, 3840);
    assert.equal(parsed.height, 2160);
    assert.ok(
      Math.abs(parsed.durationSeconds! - 110.588) < 0.5,
      `duration ${parsed.durationSeconds}`
    );

    // The 64-bit largesize path is not hypothetical: this recording uses it.
    const mdatBox = parsed.topLevelBoxes.find((b) => b.type === 'mdat')!;
    assert.equal(mdatBox.headerSize, 16);

    const report = reportFromProbe(combineProbe(info.size, emptyElement, parsed));
    assert.deepEqual(
      report.violations.map((v) => v.code),
      ['resolution', 'bitrate', 'faststart', 'videoCodec']
    );
    assert.equal(report.ok, false);
    console.log('  real file report:', report.headline);
  } finally {
    await close();
  }
});

test(
  'a real contract-compliant re-encode produces no violations',
  { skip: !compliantFile },
  async () => {
    const { source, size, close } = await fileSource(compliantFile!);

    try {
      const parsed = await parseMp4Structure(source);
      assert.equal(parsed.faststart, true, 'moov must be in front of mdat');
      assert.equal(parsed.videoFourcc, 'avc1');
      assert.equal(parsed.audioFourcc, 'mp4a');
      assert.equal(Math.max(parsed.width!, parsed.height!), 1920);

      const report = reportFromProbe(combineProbe(size, emptyElement, parsed));
      assert.deepEqual(report.violations, []);
      assert.equal(report.ok, true);
      assert.equal(report.headline, null);
    } finally {
      await close();
    }
  }
);
