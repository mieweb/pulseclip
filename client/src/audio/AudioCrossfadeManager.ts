/**
 * AudioCrossfadeManager
 * Manages Web Audio API routing for video preview with realtime crossfades.
 * Routes video element audio through a GainNode to enable fade-around-seek.
 */

import { scheduleFade } from './fadeUtils';
import { debug } from '../debug';

export interface AudioCrossfadeConfig {
  /** Fade duration in milliseconds (default: 25ms) */
  fadeDurationMs?: number;
  /** Whether to enable debug logging */
  debugMode?: boolean;
}

/**
 * Manages audio routing and crossfades for video preview playback.
 * Routes video element audio through Web Audio API to enable smooth fades.
 */
export class AudioCrossfadeManager {
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;
  private mediaElement: HTMLMediaElement | null = null;
  private fadeDurationMs: number;
  private debugMode: boolean;
  private isInitialized = false;

  constructor(config: AudioCrossfadeConfig = {}) {
    this.fadeDurationMs = config.fadeDurationMs ?? 25;
    this.debugMode = config.debugMode ?? false;
  }

  /**
   * Initialize Web Audio routing for a media element.
   * Must be called after a user interaction to allow AudioContext creation.
   * 
   * @param mediaElement - HTMLVideoElement or HTMLAudioElement to route
   * @returns true if initialization succeeded
   */
  initialize(mediaElement: HTMLMediaElement): boolean {
    if (this.isInitialized && this.mediaElement === mediaElement) {
      return true;
    }

    try {
      // Create AudioContext if needed
      if (!this.audioContext) {
        this.audioContext = new AudioContext();
        if (this.debugMode) {
          debug('Audio', `AudioContext created, state: ${this.audioContext.state}`);
        }
      }

      // Resume if suspended (required after user interaction)
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
        if (this.debugMode) {
          debug('Audio', 'AudioContext resumed');
        }
      }

      // Create audio graph: MediaElement -> GainNode -> Destination
      // Only create source if not already created for this element
      if (!this.mediaSource || this.mediaElement !== mediaElement) {
        if (this.mediaSource) {
          this.disconnect();
        }

        this.mediaSource = this.audioContext.createMediaElementSource(mediaElement);
        this.gainNode = this.audioContext.createGain();
        this.gainNode.gain.value = 1.0;

        this.mediaSource.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);

        this.mediaElement = mediaElement;
        this.isInitialized = true;

        if (this.debugMode) {
          debug('Audio', 'Web Audio routing initialized');
        }
      }

      return true;
    } catch (error) {
      console.error('[AudioCrossfadeManager] Initialization failed:', error);
      return false;
    }
  }

  /**
   * Execute a seek with fade-out, seek, fade-in pattern.
   * This reduces audio clicks and pops during timeline jumps.
   * 
   * @param seekTimeSeconds - Target time in seconds
   * @param mediaElement - Media element to seek
   * @returns Promise that resolves when seek and fade-in complete
   */
  async seekWithCrossfade(
    seekTimeSeconds: number,
    mediaElement: HTMLMediaElement
  ): Promise<void> {
    if (!this.isInitialized || !this.gainNode || !this.audioContext) {
      // Fallback to direct seek if not initialized
      mediaElement.currentTime = seekTimeSeconds;
      return;
    }

    const fadeDurationSec = this.fadeDurationMs / 1000;

    try {
      // Step 1: Fade out
      scheduleFade(this.gainNode, 1.0, 0.0, fadeDurationSec);
      
      if (this.debugMode) {
        debug('Audio', `Fade out for ${this.fadeDurationMs}ms before seek to ${seekTimeSeconds.toFixed(2)}s`);
      }

      // Wait for fade out to complete
      await new Promise(resolve => setTimeout(resolve, this.fadeDurationMs));

      // Step 2: Perform seek
      mediaElement.currentTime = seekTimeSeconds;

      // Step 3: Fade in
      scheduleFade(this.gainNode, 0.0, 1.0, fadeDurationSec);
      
      if (this.debugMode) {
        debug('Audio', `Fade in for ${this.fadeDurationMs}ms after seek`);
      }

    } catch (error) {
      console.error('[AudioCrossfadeManager] Seek with crossfade failed:', error);
      // Ensure gain is restored
      if (this.gainNode) {
        this.gainNode.gain.value = 1.0;
      }
    }
  }

  /**
   * Perform a direct seek without crossfade.
   * Use for seeks within continuous segments.
   * 
   * @param seekTimeSeconds - Target time in seconds
   * @param mediaElement - Media element to seek
   */
  seekDirect(seekTimeSeconds: number, mediaElement: HTMLMediaElement): void {
    mediaElement.currentTime = seekTimeSeconds;
  }

  /**
   * Check if the manager is initialized and ready for use.
   */
  isReady(): boolean {
    return this.isInitialized && this.audioContext?.state === 'running';
  }

  /**
   * Get the current AudioContext state.
   */
  getState(): AudioContextState | null {
    return this.audioContext?.state ?? null;
  }

  /**
   * Update fade duration.
   * 
   * @param durationMs - New fade duration in milliseconds
   */
  setFadeDuration(durationMs: number): void {
    this.fadeDurationMs = durationMs;
  }

  /**
   * Disconnect and cleanup audio routing.
   */
  disconnect(): void {
    if (this.mediaSource) {
      this.mediaSource.disconnect();
      this.mediaSource = null;
    }
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    this.isInitialized = false;
    this.mediaElement = null;

    if (this.debugMode) {
      debug('Audio', 'Web Audio routing disconnected');
    }
  }

  /**
   * Close AudioContext and cleanup all resources.
   */
  dispose(): void {
    this.disconnect();
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
      if (this.debugMode) {
        debug('Audio', 'AudioContext closed');
      }
    }
  }
}
