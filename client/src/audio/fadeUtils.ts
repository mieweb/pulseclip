/**
 * Audio fade utilities for crossfade rendering
 * Provides equal-power crossfade curves and fade scheduling
 */

/**
 * Apply an equal-power fade-out curve to an audio buffer segment.
 * Uses cosine curve for smooth perceptual fade.
 * 
 * @param buffer - AudioBuffer to modify
 * @param channel - Channel index
 * @param startSample - Sample index where fade begins
 * @param fadeSamples - Number of samples over which to fade
 */
export function applyFadeOut(
  buffer: AudioBuffer,
  channel: number,
  startSample: number,
  fadeSamples: number
): void {
  const channelData = buffer.getChannelData(channel);
  const endSample = Math.min(startSample + fadeSamples, channelData.length);
  
  for (let i = startSample; i < endSample; i++) {
    const progress = (i - startSample) / fadeSamples;
    // Equal-power fade-out: cos(progress * π/2)
    const gain = Math.cos(progress * Math.PI * 0.5);
    channelData[i] *= gain;
  }
}

/**
 * Apply an equal-power fade-in curve to an audio buffer segment.
 * Uses sine curve for smooth perceptual fade.
 * 
 * @param buffer - AudioBuffer to modify
 * @param channel - Channel index
 * @param startSample - Sample index where fade begins
 * @param fadeSamples - Number of samples over which to fade
 */
export function applyFadeIn(
  buffer: AudioBuffer,
  channel: number,
  startSample: number,
  fadeSamples: number
): void {
  const channelData = buffer.getChannelData(channel);
  const endSample = Math.min(startSample + fadeSamples, channelData.length);
  
  for (let i = startSample; i < endSample; i++) {
    const progress = (i - startSample) / fadeSamples;
    // Equal-power fade-in: sin(progress * π/2)
    const gain = Math.sin(progress * Math.PI * 0.5);
    channelData[i] *= gain;
  }
}

/**
 * Schedule a linear fade on a GainNode for realtime playback.
 * 
 * @param gainNode - GainNode to schedule fade on
 * @param startValue - Starting gain value (0-1)
 * @param endValue - Ending gain value (0-1)
 * @param durationSeconds - Duration of the fade in seconds
 * @param startTime - AudioContext time to start fade (defaults to now)
 */
export function scheduleFade(
  gainNode: GainNode,
  startValue: number,
  endValue: number,
  durationSeconds: number,
  startTime?: number
): void {
  const audioContext = gainNode.context;
  const time = startTime ?? audioContext.currentTime;
  
  gainNode.gain.cancelScheduledValues(time);
  gainNode.gain.setValueAtTime(startValue, time);
  gainNode.gain.linearRampToValueAtTime(endValue, time + durationSeconds);
}

/**
 * Calculate the number of samples for a given duration in milliseconds.
 * 
 * @param durationMs - Duration in milliseconds
 * @param sampleRate - Sample rate in Hz
 * @returns Number of samples
 */
export function msToSamples(durationMs: number, sampleRate: number): number {
  return Math.floor((durationMs / 1000) * sampleRate);
}

/**
 * Calculate duration in milliseconds from number of samples.
 * 
 * @param samples - Number of samples
 * @param sampleRate - Sample rate in Hz
 * @returns Duration in milliseconds
 */
export function samplesToMs(samples: number, sampleRate: number): number {
  return (samples / sampleRate) * 1000;
}
