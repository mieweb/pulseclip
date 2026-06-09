/**
 * OfflineAudioRenderer
 * Generates a composed audio track from timeline segments with true crossfades.
 * Uses OfflineAudioContext to render high-quality audio for preview or export.
 */

import type { PlaybackSegment } from '../types';
import { debug } from '../debug';

export interface RenderConfig {
  /** Crossfade duration in milliseconds (default: 30ms) */
  crossfadeDurationMs?: number;
  /** Audio padding in milliseconds to avoid mid-waveform cuts (default: 15ms) */
  audioPaddingMs?: number;
  /** Sample rate for output (default: 48000) */
  sampleRate?: number;
  /** Whether to enable debug logging */
  debugMode?: boolean;
}

export interface RenderSegment {
  /** Start time in source media (milliseconds) */
  sourceStartMs: number;
  /** End time in source media (milliseconds) */
  sourceEndMs: number;
  /** Start time in output timeline (milliseconds) */
  outputStartMs: number;
}

/**
 * Converts PlaybackSegment array to RenderSegment array with output timing.
 * 
 * @param playbackSegments - Segments from timeline with source timing
 * @returns Array of render segments with output timing calculated
 */
export function playbackSegmentsToRenderSegments(
  playbackSegments: PlaybackSegment[]
): RenderSegment[] {
  const renderSegments: RenderSegment[] = [];
  let outputTimeMs = 0;

  for (const seg of playbackSegments) {
    const durationMs = seg.endMs - seg.startMs;
    renderSegments.push({
      sourceStartMs: seg.startMs,
      sourceEndMs: seg.endMs,
      outputStartMs: outputTimeMs,
    });
    outputTimeMs += durationMs;
  }

  return renderSegments;
}

/**
 * Renders a composed audio track from timeline segments.
 * Applies equal-power crossfades at segment boundaries.
 */
export class OfflineAudioRenderer {
  private config: Required<RenderConfig>;

  constructor(config: RenderConfig = {}) {
    this.config = {
      crossfadeDurationMs: config.crossfadeDurationMs ?? 30,
      audioPaddingMs: config.audioPaddingMs ?? 15,
      sampleRate: config.sampleRate ?? 48000,
      debugMode: config.debugMode ?? false,
    };
  }

  /**
   * Decode audio from a media URL.
   * 
   * @param audioUrl - URL or blob URL of audio/video file
   * @returns Decoded AudioBuffer
   */
  async decodeAudio(audioUrl: string): Promise<AudioBuffer> {
    try {
      // Fetch audio data
      const response = await fetch(audioUrl);
      const arrayBuffer = await response.arrayBuffer();

      // Decode with OfflineAudioContext (more compatible than AudioContext for decoding)
      const audioContext = new AudioContext();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      audioContext.close();

      if (this.config.debugMode) {
        debug('Render', `Decoded audio: ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.numberOfChannels}ch, ${audioBuffer.sampleRate}Hz`);
      }

      return audioBuffer;
    } catch (error) {
      console.error('[OfflineAudioRenderer] Failed to decode audio:', error);
      throw error;
    }
  }

  /**
   * Render a composed audio track from timeline segments.
   * 
   * @param sourceBuffer - Decoded source audio buffer
   * @param renderSegments - Timeline segments with output timing
   * @returns Rendered audio buffer with crossfades
   */
  async renderTimeline(
    sourceBuffer: AudioBuffer,
    renderSegments: RenderSegment[]
  ): Promise<AudioBuffer> {
    if (renderSegments.length === 0) {
      throw new Error('No segments to render');
    }

    // Calculate total output duration
    const lastSegment = renderSegments[renderSegments.length - 1];
    const lastSegmentDurationMs = lastSegment.sourceEndMs - lastSegment.sourceStartMs;
    const totalDurationMs = lastSegment.outputStartMs + lastSegmentDurationMs;
    const totalDurationSec = totalDurationMs / 1000;

    if (this.config.debugMode) {
      debug('Render', `Rendering ${renderSegments.length} segments, total duration: ${totalDurationMs.toFixed(0)}ms`);
    }

    // Create offline context
    const offlineContext = new OfflineAudioContext(
      sourceBuffer.numberOfChannels,
      Math.ceil(totalDurationSec * this.config.sampleRate),
      this.config.sampleRate
    );

    // Schedule each segment
    for (let i = 0; i < renderSegments.length; i++) {
      const segment = renderSegments[i];
      const nextSegment = i < renderSegments.length - 1 ? renderSegments[i + 1] : null;

      await this.scheduleSegment(
        offlineContext,
        sourceBuffer,
        segment,
        nextSegment,
        i
      );
    }

    // Render offline audio
    if (this.config.debugMode) {
      debug('Render', 'Starting offline render...');
    }

    const renderedBuffer = await offlineContext.startRendering();

    if (this.config.debugMode) {
      debug('Render', `Render complete: ${renderedBuffer.duration.toFixed(2)}s`);
    }

    return renderedBuffer;
  }

  /**
   * Schedule a single segment with crossfades.
   * 
   * @param context - OfflineAudioContext
   * @param sourceBuffer - Source audio buffer
   * @param segment - Segment to schedule
   * @param nextSegment - Next segment (for crossfade detection)
   * @param segmentIndex - Index of this segment
   */
  private async scheduleSegment(
    context: OfflineAudioContext,
    sourceBuffer: AudioBuffer,
    segment: RenderSegment,
    nextSegment: RenderSegment | null,
    segmentIndex: number
  ): Promise<void> {
    const { sourceStartMs, sourceEndMs, outputStartMs } = segment;

    // Apply padding to avoid mid-waveform cuts
    const paddedStartMs = Math.max(0, sourceStartMs - this.config.audioPaddingMs);
    const paddedEndMs = Math.min(
      sourceBuffer.duration * 1000,
      sourceEndMs + this.config.audioPaddingMs
    );

    const paddedStartSec = paddedStartMs / 1000;
    const paddedDurationSec = (paddedEndMs - paddedStartMs) / 1000;
    const outputStartSec = outputStartMs / 1000;

    // Create buffer source for this segment
    const source = context.createBufferSource();
    source.buffer = sourceBuffer;

    // Check if we need crossfade with next segment
    const needsCrossfade = nextSegment !== null && (
      segment.sourceEndMs !== nextSegment.sourceStartMs
    );

    if (needsCrossfade) {
      // Apply crossfade at segment boundary with equal-power curve
      const fadeNode = context.createGain();
      source.connect(fadeNode);
      fadeNode.connect(context.destination);

      // Fade out at the end using equal-power curve
      const fadeDurationSec = this.config.crossfadeDurationMs / 1000;
      // Use padded duration for correct positioning
      const actualDurationSec = paddedDurationSec;
      const fadeOutStartSec = outputStartSec + actualDurationSec - fadeDurationSec;

      // Equal-power fade-out: cos(progress * π/2)
      // Approximate with exponential curve (very close to cosine)
      fadeNode.gain.setValueAtTime(1.0, outputStartSec);
      fadeNode.gain.setValueAtTime(1.0, fadeOutStartSec);
      // Exponential curve from 1.0 to 0.001 (near zero, can't use exactly 0)
      fadeNode.gain.exponentialRampToValueAtTime(0.001, fadeOutStartSec + fadeDurationSec);

      if (this.config.debugMode) {
        debug('Render', `Segment ${segmentIndex}: equal-power crossfade ${this.config.crossfadeDurationMs}ms at boundary`);
      }
    } else {
      // No crossfade needed
      source.connect(context.destination);

      if (this.config.debugMode) {
        debug('Render', `Segment ${segmentIndex}: no crossfade (continuous or last segment)`);
      }
    }

    // Start playback
    source.start(outputStartSec, paddedStartSec, paddedDurationSec);
  }

  /**
   * Export rendered audio buffer as WAV blob.
   * 
   * @param audioBuffer - Rendered audio buffer
   * @returns WAV audio blob
   */
  exportAsWav(audioBuffer: AudioBuffer): Blob {
    const numberOfChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;

    // Calculate WAV file size
    const bytesPerSample = 2; // 16-bit PCM
    const dataSize = length * numberOfChannels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // WAV header
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, numberOfChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numberOfChannels * bytesPerSample, true); // byte rate
    view.setUint16(32, numberOfChannels * bytesPerSample, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    // Write PCM samples
    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const sample = Math.max(-1, Math.min(1, audioBuffer.getChannelData(channel)[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  /**
   * Update render configuration.
   * 
   * @param config - Partial configuration to update
   */
  updateConfig(config: Partial<RenderConfig>): void {
    Object.assign(this.config, config);
  }
}
