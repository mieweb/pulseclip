import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  contractTargetSize,
  extractAudioSpecificConfig,
  rotationFromMatrix,
} from '../src/lib/transcodeToContract.ts';

describe('contractTargetSize', () => {
  it('caps a landscape 4K frame at the long edge', () => {
    assert.deepEqual(contractTargetSize(3840, 2160), { width: 1920, height: 1080 });
  });

  it('caps a PORTRAIT 4K frame by its height, not its width', () => {
    // The trap this whole feature keeps tripping over: a phone capture displays as
    // 2160x3840, and capping "width" would produce 1920x3414 — longer than the source.
    assert.deepEqual(contractTargetSize(2160, 3840), { width: 1080, height: 1920 });
  });

  it('never upscales something already inside the contract', () => {
    assert.deepEqual(contractTargetSize(1280, 720), { width: 1280, height: 720 });
    assert.deepEqual(contractTargetSize(640, 480), { width: 640, height: 480 });
  });

  it('leaves a frame sitting exactly on the cap alone', () => {
    assert.deepEqual(contractTargetSize(1920, 1080), { width: 1920, height: 1080 });
  });

  it('always produces even dimensions, which H.264 4:2:0 requires', () => {
    for (const [w, h] of [
      [3841, 2161],
      [2999, 1777],
      [1081, 1921],
      [333, 777],
    ]) {
      const out = contractTargetSize(w, h);
      assert.equal(out.width % 2, 0, `width ${out.width} from ${w}x${h}`);
      assert.equal(out.height % 2, 0, `height ${out.height} from ${w}x${h}`);
      assert.ok(Math.max(out.width, out.height) <= 1920);
    }
  });

  it('preserves aspect ratio within a pixel of rounding', () => {
    const src = { w: 3840, h: 2160 };
    const out = contractTargetSize(src.w, src.h);
    assert.ok(Math.abs(out.width / out.height - src.w / src.h) < 0.01);
  });
});

describe('rotationFromMatrix', () => {
  const U = 65536;
  it('reads the four right-angle orientations', () => {
    assert.equal(rotationFromMatrix([U, 0, 0, 0, U, 0, 0, 0, 1]), 0);
    assert.equal(rotationFromMatrix([0, U, 0, -U, 0, 0, 0, 0, 1]), 90);
    assert.equal(rotationFromMatrix([-U, 0, 0, 0, -U, 0, 0, 0, 1]), 180);
    assert.equal(rotationFromMatrix([0, -U, 0, U, 0, 0, 0, 0, 1]), 270);
  });

  it('falls back to 0 for a missing or unreadable matrix', () => {
    assert.equal(rotationFromMatrix(undefined), 0);
    assert.equal(rotationFromMatrix([1, 2]), 0);
    // A shear/arbitrary affine is deliberately not baked.
    assert.equal(rotationFromMatrix([U / 2, U / 3, 0, 0, U, 0, 0, 0, 1]), 0);
  });
});

describe('extractAudioSpecificConfig', () => {
  it('passes through a bare AudioSpecificConfig (what Chrome returns)', () => {
    const asc = new Uint8Array([0x11, 0x90]); // AAC-LC, 48kHz, mono
    assert.deepEqual(extractAudioSpecificConfig(asc), asc);
  });

  it('digs the config out of a full ES_Descriptor (what WebKit returns)', () => {
    // 0x03 ES_Descriptor -> 0x04 DecoderConfigDescriptor -> 0x05 DecoderSpecificInfo.
    // Written verbatim into an esds, the outer descriptor yields a track ffmpeg reads as
    // "Audio object type 0 ... 0 channels" — video fine, audio silently broken.
    const asc = [0x11, 0x90];
    const dsi = [0x05, asc.length, ...asc];
    const dcd = [0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...dsi];
    const es = new Uint8Array([0x03, 3 + dcd.length, 0x00, 0x01, 0x00, ...dcd]);
    assert.deepEqual(Array.from(extractAudioSpecificConfig(es)), asc);
  });

  it('handles the optional ES_Descriptor fields the flags announce', () => {
    const asc = [0x12, 0x10];
    const dsi = [0x05, asc.length, ...asc];
    const dcd = [0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...dsi];
    // streamDependenceFlag (0x80) adds a 2-byte dependsOn_ES_ID before the child descriptors.
    const es = new Uint8Array([0x03, 5 + dcd.length, 0x00, 0x01, 0x80, 0x00, 0x02, ...dcd]);
    assert.deepEqual(Array.from(extractAudioSpecificConfig(es)), asc);
  });

  it('returns the input rather than throwing on garbage', () => {
    const junk = new Uint8Array([0x03, 0x7f, 0x00]);
    assert.ok(extractAudioSpecificConfig(junk) instanceof Uint8Array);
    assert.deepEqual(extractAudioSpecificConfig(new Uint8Array()), new Uint8Array());
  });
});
