import { createFile, DataStream, Endianness, MP4BoxBuffer } from 'mp4box';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

import { UPLOAD_CONTRACT } from './videoContract.ts';

/**
 * Client-side re-encode into the upload contract (v2 of the browser clamp).
 *
 * v1 detects a contract breach and warns; this brings the file into the contract before
 * it is uploaded, entirely in the browser:
 *
 *     H.264 · long edge <= 1920 · <= 5 Mbps · AAC · faststart
 *
 * Why WebCodecs rather than the obvious alternatives:
 *
 * - `MediaRecorder` over a canvas capture is realtime-bound (a 3-minute clip takes 3
 *   minutes) and produces WebM/VP8 outside Safari, which is not the contract.
 * - A `<video>` element cannot even read the files that matter most: Chrome decodes HEVC
 *   through WebCodecs but reports `canPlayType('video/mp4; codecs="hvc1"') === ''`, so an
 *   element-based pipeline silently fails on exactly the 4K HEVC captures this exists for.
 *
 * Container work is delegated: mp4box (BSD-3) demuxes, mp4-muxer (MIT) muxes. Both are
 * deliberate — a subtly wrong hand-rolled sample-table reader corrupts a user's upload,
 * and the variations (co64 vs stco, ctts, edit lists, hvc1 vs hev1) are not something this
 * codebase can regression-test. The contract policy and the pipeline stay ours.
 *
 * Rotation is BAKED IN rather than passed through as a display matrix, so the output needs
 * no orientation metadata to play correctly anywhere. That also means the long-edge cap is
 * applied to DISPLAY dimensions — a portrait 3840x2160+90deg capture displays as 2160x3840,
 * and capping its coded width would produce a 1920x3414 file: taller than the source and
 * still over the ceiling.
 */

/**
 * Video budget = the contract ceiling minus the audio track, so the FINISHED FILE lands
 * under 5 Mbps rather than the video stream alone doing so. Without this the output measures
 * ~5.3 Mbps and only passes its own contract by leaning on the detector's grace factor.
 */
const VIDEO_BITRATE = UPLOAD_CONTRACT.maxBitrateBps - 128_000;
/** Encoder target. Main@4.0 covers 1920x1080@30; Baseline is the fallback. */
const AVC_CODECS = ['avc1.4D4028', 'avc1.42E028'] as const;
/** Audio target: AAC-LC, the contract's audio codec. */
const AAC_CODEC = 'mp4a.40.2';
const AUDIO_BITRATE = 128_000;
/** Frame-rate ceiling; matches the ffmpeg fix command and the recorder's own pin. */
const TARGET_FPS = 30;
/**
 * Refuse rather than crash the tab. The pipeline holds the source bytes, the demuxed
 * samples and the muxed output concurrently, so peak memory is a small multiple of the
 * file. Past this we keep the v1 warning instead.
 */
export const MAX_TRANSCODE_BYTES = 1_200_000_000;
/** How many audio frames to hand the encoder at a time. */
const AUDIO_CHUNK_FRAMES = 4096;

/**
 * Reduce an AAC `decoderConfig.description` to the bare AudioSpecificConfig a muxer embeds.
 *
 * The two engines disagree about what `description` means. Chrome hands back the ASC itself
 * (2 bytes). WebKit hands back a whole MPEG-4 ES_Descriptor (~39 bytes) with the ASC buried
 * inside it. Written verbatim into an `esds`, WebKit's version yields a track ffmpeg reads as
 * "Audio object type 0 ... 0 channels" at the wrong sample rate — a file whose video is fine
 * and whose audio is silently unplayable.
 *
 * Descriptors are tag / variable-length-size / payload; we walk into ES_Descriptor (0x03) and
 * DecoderConfigDescriptor (0x04) to find DecoderSpecificInfo (0x05). Anything that does not
 * look like a descriptor tree is already an ASC and passes through untouched.
 */
export function extractAudioSpecificConfig(description: Uint8Array): Uint8Array {
  if (description.length === 0 || description[0] !== 0x03) return description;
  let i = 0;
  const readLength = (): number => {
    let size = 0;
    let byte: number;
    do {
      byte = description[i++];
      size = (size << 7) | (byte & 0x7f);
    } while (byte & 0x80 && i < description.length);
    return size;
  };
  while (i < description.length) {
    const tag = description[i++];
    const size = readLength();
    if (tag === 0x05) return description.subarray(i, i + size);
    if (tag === 0x03) {
      // ES_ID(2) + flags(1), plus the optional fields the flags announce.
      const flags = description[i + 2];
      i += 3;
      if (flags & 0x80) i += 2; // streamDependenceFlag -> dependsOn_ES_ID
      if (flags & 0x40) i += 1 + description[i]; // URL_Flag -> length-prefixed URL
      if (flags & 0x20) i += 2; // OCRstreamFlag -> OCR_ES_Id
      continue;
    }
    if (tag === 0x04) {
      // objectTypeIndication(1) + streamType/bufferSizeDB(4) + maxBitrate(4) + avgBitrate(4)
      i += 13;
      continue;
    }
    i += size;
  }
  return description;
}

export type TranscodePhase = 'inspecting' | 'video' | 'audio' | 'finishing';

export interface TranscodeProgress {
  phase: TranscodePhase;
  /** 0..1 within the whole job, monotonic. */
  ratio: number;
}

export interface TranscodeOptions {
  onProgress?: (progress: TranscodeProgress) => void;
  signal?: AbortSignal;
}

export interface TranscodeSupport {
  supported: boolean;
  /** Why not, when unsupported — surfaced so the UI can fall back to the v1 warning honestly. */
  reason?: string;
}

/** Even, non-upscaling dimensions whose long edge is at most the contract's cap. */
export function contractTargetSize(
  displayWidth: number,
  displayHeight: number
): { width: number; height: number } {
  const longEdge = Math.max(displayWidth, displayHeight);
  // Never upscale: a compliant-but-small clip keeps its own size.
  const scale = longEdge > UPLOAD_CONTRACT.maxLongEdge ? UPLOAD_CONTRACT.maxLongEdge / longEdge : 1;
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(displayWidth), height: even(displayHeight) };
}

/**
 * Rotation in degrees from a track's 3x3 display matrix (16.16 fixed point).
 * Only the four right-angle cases occur in camera output; anything else is treated as 0
 * because baking an arbitrary affine transform is not worth the risk of getting it wrong.
 */
export function rotationFromMatrix(matrix: ArrayLike<number> | undefined): 0 | 90 | 180 | 270 {
  if (!matrix || matrix.length < 5) return 0;
  const unit = 65536;
  const a = Math.round(matrix[0] / unit);
  const b = Math.round(matrix[1] / unit);
  if (a === 0 && b === 1) return 90;
  if (a === -1 && b === 0) return 180;
  if (a === 0 && b === -1) return 270;
  return 0;
}

/** Whether this browser can run the pipeline for a given source codec. */
export async function canTranscodeToContract(
  sourceCodec: string | undefined,
  codedWidth: number,
  codedHeight: number
): Promise<TranscodeSupport> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    return { supported: false, reason: 'this browser has no WebCodecs support' };
  }
  if (sourceCodec) {
    try {
      // hardwareAcceleration is left at the default on purpose: Chrome only decodes HEVC
      // through a platform decoder, so asking for 'prefer-software' reports unsupported on
      // exactly the files this is for.
      const decodable = await VideoDecoder.isConfigSupported({
        codec: sourceCodec,
        codedWidth,
        codedHeight,
      });
      if (!decodable.supported) {
        return { supported: false, reason: `this browser cannot decode ${sourceCodec}` };
      }
    } catch {
      return { supported: false, reason: `this browser cannot decode ${sourceCodec}` };
    }
  }
  for (const codec of AVC_CODECS) {
    try {
      const encodable = await VideoEncoder.isConfigSupported({
        codec,
        width: 1920,
        height: 1080,
        bitrate: UPLOAD_CONTRACT.maxBitrateBps,
        framerate: TARGET_FPS,
        avc: { format: 'avc' },
      });
      if (encodable.supported) return { supported: true };
    } catch {
      // try the next profile
    }
  }
  return { supported: false, reason: 'this browser cannot encode H.264' };
}

interface DemuxedVideo {
  config: VideoDecoderConfig;
  samples: { data: Uint8Array; timestampUs: number; durationUs: number; isKey: boolean }[];
  rotation: 0 | 90 | 180 | 270;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  fps: number;
  /** Source audio rate, so decoding can avoid a pointless resample. Null when silent. */
  audioSampleRate: number | null;
}

/** The avcC / hvcC payload the decoder needs, extracted from the sample description. */
function codecDescription(file: ReturnType<typeof createFile>, trackId: number): Uint8Array {
  const trak = file.getTrackById(trackId);
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? [];
  for (const entry of entries as unknown as Record<string, unknown>[]) {
    const box = (entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C) as
      | { write: (s: DataStream) => void }
      | undefined;
    if (!box) continue;
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    box.write(stream);
    // Strip the 8-byte box header; the decoder wants the payload only.
    return new Uint8Array((stream.buffer as ArrayBuffer).slice(8));
  }
  throw new Error('This file has no readable video codec configuration.');
}

function demuxVideo(bytes: ArrayBuffer): Promise<DemuxedVideo> {
  return new Promise((resolve, reject) => {
    const file = createFile();
    const samples: DemuxedVideo['samples'] = [];
    let settled = false;

    file.onError = (e: unknown) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Could not read this MP4 (${String(e)}).`));
      }
    };

    file.onReady = (info) => {
      const track = info.videoTracks?.[0];
      if (!track) {
        settled = true;
        reject(new Error('This file has no video track.'));
        return;
      }
      const rotation = rotationFromMatrix(track.matrix as unknown as ArrayLike<number>);
      const codedWidth = track.video?.width ?? track.track_width;
      const codedHeight = track.video?.height ?? track.track_height;
      const swapped = rotation === 90 || rotation === 270;
      const durationS = track.duration && track.timescale ? track.duration / track.timescale : 0;
      const fps = durationS > 0 ? track.nb_samples / durationS : TARGET_FPS;

      let description: Uint8Array;
      try {
        description = codecDescription(file, track.id);
      } catch (e) {
        settled = true;
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      file.onSamples = (_id, _user, incoming) => {
        for (const s of incoming) {
          samples.push({
            // Copy: mp4box reuses/releases its buffers once the sample is delivered.
            data: new Uint8Array(s.data as unknown as Uint8Array),
            timestampUs: (s.cts / s.timescale) * 1_000_000,
            durationUs: (s.duration / s.timescale) * 1_000_000,
            isKey: s.is_sync,
          });
        }
        if (samples.length >= track.nb_samples && !settled) {
          settled = true;
          file.flush();
          // Zero-base the presentation timestamps. A capture with B-frames (or an edit list)
          // starts its first *composition* time above zero, and a muxer requires the first
          // chunk at 0. Subtracting the minimum rather than the first sample's own value is
          // deliberate: samples arrive in DECODE order, so the first one is not necessarily
          // the earliest to be presented.
          const baseUs = samples.reduce((min, s2) => Math.min(min, s2.timestampUs), Infinity);
          if (Number.isFinite(baseUs) && baseUs !== 0) {
            for (const s2 of samples) s2.timestampUs -= baseUs;
          }
          resolve({
            config: { codec: track.codec, codedWidth, codedHeight, description },
            samples,
            rotation,
            codedWidth,
            codedHeight,
            displayWidth: swapped ? codedHeight : codedWidth,
            displayHeight: swapped ? codedWidth : codedHeight,
            fps: Math.min(fps || TARGET_FPS, 240),
            audioSampleRate: info.audioTracks?.[0]?.audio?.sample_rate ?? null,
          });
        }
      };

      file.setExtractionOptions(track.id, null, { nbSamples: 200 });
      file.start();
    };

    const buffer = MP4BoxBuffer.fromArrayBuffer(bytes, 0);
    file.appendBuffer(buffer);
    file.flush();
    if (!settled) {
      settled = true;
      reject(new Error('This file could not be parsed as an MP4.'));
    }
  });
}

/** Draws a decoded frame into the target canvas, baking rotation so the output needs no matrix. */
function drawRotated(
  ctx: OffscreenCanvasRenderingContext2D,
  frame: VideoFrame,
  rotation: 0 | 90 | 180 | 270,
  targetWidth: number,
  targetHeight: number
): void {
  ctx.save();
  switch (rotation) {
    case 90:
      ctx.translate(targetWidth, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(frame, 0, 0, targetHeight, targetWidth);
      break;
    case 180:
      ctx.translate(targetWidth, targetHeight);
      ctx.rotate(Math.PI);
      ctx.drawImage(frame, 0, 0, targetWidth, targetHeight);
      break;
    case 270:
      ctx.translate(0, targetHeight);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(frame, 0, 0, targetHeight, targetWidth);
      break;
    default:
      ctx.drawImage(frame, 0, 0, targetWidth, targetHeight);
  }
  ctx.restore();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Transcode cancelled', 'AbortError');
}

/** Lets the decoder/encoder drain so their queues never grow without bound. */
async function awaitQueueBelow(
  codec: { encodeQueueSize?: number; decodeQueueSize?: number },
  limit: number,
  // Checked each tick: without it, a codec that has errored stops draining and this
  // would spin until the tab is closed.
  failed: () => Error | null
) {
  while ((codec.encodeQueueSize ?? codec.decodeQueueSize ?? 0) > limit) {
    const err = failed();
    if (err) throw err;
    await new Promise((r) => setTimeout(r, 4));
  }
}

/**
 * Re-encode `file` into the upload contract. Resolves to a new `File` ready to upload;
 * rejects if the browser cannot run the pipeline or the source cannot be read.
 */
export async function transcodeToContract(
  file: File,
  { onProgress, signal }: TranscodeOptions = {}
): Promise<File> {
  if (file.size > MAX_TRANSCODE_BYTES) {
    throw new Error('This file is too large to convert in the browser.');
  }
  const report = (phase: TranscodePhase, ratio: number) =>
    onProgress?.({ phase, ratio: Math.max(0, Math.min(1, ratio)) });

  report('inspecting', 0);
  throwIfAborted(signal);
  const bytes = await file.arrayBuffer();
  const video = await demuxVideo(bytes);
  throwIfAborted(signal);

  const support = await canTranscodeToContract(
    video.config.codec,
    video.codedWidth,
    video.codedHeight
  );
  if (!support.supported) throw new Error(support.reason ?? 'Conversion is not supported here.');

  const { width, height } = contractTargetSize(video.displayWidth, video.displayHeight);
  const fps = Math.min(video.fps, TARGET_FPS);

  // Audio first, decoded off the same bytes. decodeAudioData detaches its input, so it gets
  // its own copy. A file with no audio track simply yields nothing here.
  let audioBuffer: AudioBuffer | null = null;
  try {
    // Pin the context to the SOURCE rate. Left to default, an AudioContext opens at the
    // output device's rate (44.1kHz on most Macs) and decodeAudioData silently resamples a
    // 48kHz recording on the way in — a quality loss for nothing, since the encoder is
    // perfectly happy to write 48kHz.
    const AudioCtor =
      window.AudioContext ??
      (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioCtx = video.audioSampleRate
      ? new AudioCtor({ sampleRate: video.audioSampleRate })
      : new AudioCtor();
    audioBuffer = await audioCtx.decodeAudioData(bytes.slice(0));
    void audioCtx.close();
  } catch {
    audioBuffer = null; // silent clip, or audio this browser cannot decode
  }
  throwIfAborted(signal);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    ...(audioBuffer
      ? {
          audio: {
            codec: 'aac',
            numberOfChannels: Math.min(audioBuffer.numberOfChannels, 2),
            sampleRate: audioBuffer.sampleRate,
          },
        }
      : {}),
    // The contract's faststart requirement: the index is written at the front.
    fastStart: 'in-memory',
  });

  // ---- video ----
  let encoderError: Error | null = null;
  let encodedChunks = 0;
  let sawDecoderConfig = false;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      encodedChunks += 1;
      if (meta?.decoderConfig) sawDecoderConfig = true;
      try {
        muxer.addVideoChunk(chunk, meta);
      } catch (e) {
        // A rejected chunk would otherwise vanish here and only surface as an unrelated
        // failure at finalize(), with every frame silently dropped in between.
        if (!encoderError) encoderError = e instanceof Error ? e : new Error(String(e));
      }
    },
    error: (e) => {
      encoderError = e instanceof Error ? e : new Error(String(e));
    },
  });
  let configured = false;
  for (const codec of AVC_CODECS) {
    try {
      const ok = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate: VIDEO_BITRATE,
        framerate: fps,
        avc: { format: 'avc' },
      });
      if (!ok.supported) continue;
      encoder.configure({
        codec,
        width,
        height,
        bitrate: VIDEO_BITRATE,
        framerate: fps,
        avc: { format: 'avc' },
        // Keyframes every 2s, matching what export.ts already emits — without them,
        // scrubbing snaps back on long-GOP output.
        latencyMode: 'quality',
      });
      configured = true;
      break;
    } catch {
      // try the next profile
    }
  }
  if (!configured) throw new Error('This browser cannot encode H.264 at the required size.');

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Could not open a drawing surface for conversion.');

  const total = video.samples.length || 1;
  let decoded = 0;
  let decoderError: Error | null = null;
  const keyframeIntervalUs = 2_000_000;
  let lastKeyframeUs = -Infinity;

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        drawRotated(ctx, frame, video.rotation, width, height);
        const timestamp = frame.timestamp;
        const scaled = new VideoFrame(canvas, {
          timestamp,
          duration: frame.duration ?? Math.round(1_000_000 / fps),
        });
        const keyFrame = timestamp - lastKeyframeUs >= keyframeIntervalUs;
        if (keyFrame) lastKeyframeUs = timestamp;
        encoder.encode(scaled, { keyFrame });
        scaled.close();
      } catch (e) {
        decoderError = e instanceof Error ? e : new Error(String(e));
      } finally {
        frame.close();
        decoded += 1;
        // Video is the bulk of the work; give it the first 85% of the bar.
        report('video', (decoded / total) * 0.85);
      }
    },
    error: (e) => {
      decoderError = e instanceof Error ? e : new Error(String(e));
    },
  });
  decoder.configure(video.config);

  for (const sample of video.samples) {
    throwIfAborted(signal);
    if (decoderError) throw decoderError;
    if (encoderError) throw encoderError;
    decoder.decode(
      new EncodedVideoChunk({
        type: sample.isKey ? 'key' : 'delta',
        timestamp: sample.timestampUs,
        duration: sample.durationUs,
        data: sample.data,
      })
    );
    const failed = () => decoderError ?? encoderError;
    await awaitQueueBelow(decoder, 24, failed);
    await awaitQueueBelow(encoder, 24, failed);
  }
  await decoder.flush();
  await encoder.flush();
  decoder.close();
  encoder.close();
  if (decoderError) throw decoderError;
  if (encoderError) throw encoderError;
  if (encodedChunks === 0 || !sawDecoderConfig) {
    throw new Error('Conversion produced no video (the source could not be decoded here).');
  }

  // ---- audio ----
  if (audioBuffer) {
    report('audio', 0.88);
    throwIfAborted(signal);
    let audioError: Error | null = null;
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        const description = meta?.decoderConfig?.description;
        const normalized =
          description && meta?.decoderConfig
            ? {
                ...meta,
                decoderConfig: {
                  ...meta.decoderConfig,
                  description: extractAudioSpecificConfig(
                    new Uint8Array(description as ArrayBuffer)
                  ),
                },
              }
            : meta;
        try {
          muxer.addAudioChunk(chunk, normalized);
        } catch (e) {
          if (!audioError) audioError = e instanceof Error ? e : new Error(String(e));
        }
      },
      error: (e) => {
        audioError = e instanceof Error ? e : new Error(String(e));
      },
    });
    const channels = Math.min(audioBuffer.numberOfChannels, 2);
    audioEncoder.configure({
      codec: AAC_CODEC,
      sampleRate: audioBuffer.sampleRate,
      numberOfChannels: channels,
      bitrate: AUDIO_BITRATE,
    });

    const planes: Float32Array[] = [];
    for (let c = 0; c < channels; c += 1) planes.push(audioBuffer.getChannelData(c));
    const frames = audioBuffer.length;
    for (let offset = 0; offset < frames; offset += AUDIO_CHUNK_FRAMES) {
      throwIfAborted(signal);
      if (audioError) throw audioError;
      const count = Math.min(AUDIO_CHUNK_FRAMES, frames - offset);
      // f32-planar wants each channel's samples laid end to end.
      const interleaved = new Float32Array(count * channels);
      for (let c = 0; c < channels; c += 1) {
        interleaved.set(planes[c].subarray(offset, offset + count), c * count);
      }
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate: audioBuffer.sampleRate,
        numberOfFrames: count,
        numberOfChannels: channels,
        timestamp: Math.round((offset / audioBuffer.sampleRate) * 1_000_000),
        data: interleaved,
      });
      audioEncoder.encode(data);
      data.close();
      await awaitQueueBelow(audioEncoder, 32, () => audioError);
      report('audio', 0.85 + (offset / frames) * 0.1);
    }
    await audioEncoder.flush();
    audioEncoder.close();
    if (audioError) throw audioError;
  }

  report('finishing', 0.97);
  throwIfAborted(signal);
  muxer.finalize();
  const { buffer } = muxer.target as ArrayBufferTarget;
  report('finishing', 1);

  const name = file.name.replace(/\.[^.]+$/, '') || 'upload';
  return new File([buffer], `${name}.mp4`, { type: 'video/mp4' });
}
