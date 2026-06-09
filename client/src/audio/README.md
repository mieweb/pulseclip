# Audio Crossfade Rendering

This module provides audio crossfade capabilities for PulseClip's word-level video editing workflow.

## Overview

When editing videos at the word level, users can delete words and rearrange sequences. This creates **hard cuts** in the audio that can sound jarring, especially at word boundaries. This module solves that problem with two complementary approaches:

1. **Realtime Preview Smoothing** - Fade-around-seek for instant preview playback
2. **Offline Audio Rendering** - True crossfades for high-quality output

## Architecture

```
Audio Module
├── fadeUtils.ts              # Core fade curve utilities
├── AudioCrossfadeManager.ts  # Realtime preview smoothing
├── OfflineAudioRenderer.ts   # Offline audio composition
└── index.ts                  # Public API exports
```

## Usage

### Realtime Preview (Automatic)

The `AudioCrossfadeManager` is automatically integrated into the TranscriptViewer component. It:

- Routes video audio through Web Audio API
- Applies short fade-out/fade-in around seek operations
- Only fades at **non-contiguous segment boundaries**
- Continuous sequences play without fades
- Default fade duration: 25ms

**No manual intervention required** - it activates on first playback.

### Offline Audio Rendering (API)

For high-quality audio export or preview, use the `OfflineAudioRenderer`:

```typescript
import { 
  OfflineAudioRenderer, 
  playbackSegmentsToRenderSegments 
} from '../audio';

// 1. Get playback segments from your timeline
const playbackSegments = buildPlaybackSegments(editedWords);

// 2. Convert to render segments with output timing
const renderSegments = playbackSegmentsToRenderSegments(playbackSegments);

// 3. Create renderer with config
const renderer = new OfflineAudioRenderer({
  crossfadeDurationMs: 30,    // Crossfade length
  audioPaddingMs: 15,          // Padding to avoid mid-waveform cuts
  sampleRate: 48000,           // Output sample rate
  debugMode: false             // Enable console logging
});

// 4. Decode source audio
const audioBuffer = await renderer.decodeAudio(mediaUrl);

// 5. Render composed timeline
const renderedBuffer = await renderer.renderTimeline(audioBuffer, renderSegments);

// 6. Export as WAV (optional)
const wavBlob = renderer.exportAsWav(renderedBuffer);
```

## Key Concepts

### Segment Boundaries

Crossfades are **only applied at segment boundaries** where:
- `currentSegment.endMs !== nextSegment.startMs`

This means:
- ✅ **Crossfaded**: Word sequences with gaps (deleted words, reordering)
- ❌ **Not crossfaded**: Continuous word sequences in original order

### Equal-Power Crossfades

Uses complementary cosine/sine curves for perceptually smooth transitions:
- Fade-out: `gain = cos(progress * π/2)`
- Fade-in: `gain = sin(progress * π/2)`

This maintains consistent perceived loudness during the transition.

### Audio Padding

Optional padding (default 15ms) extends segment boundaries to avoid cutting mid-waveform:
```
[word audio]    [15ms padding] --- gap --- [15ms padding]    [next word]
```

Helps prevent clicks when audio is cut precisely at word boundaries.

## Configuration

### AudioCrossfadeManager

```typescript
const manager = new AudioCrossfadeManager({
  fadeDurationMs: 25,   // Fade duration (default: 25ms)
  debugMode: false      // Enable debug logging
});
```

### OfflineAudioRenderer

```typescript
const renderer = new OfflineAudioRenderer({
  crossfadeDurationMs: 30,  // Crossfade duration (default: 30ms)
  audioPaddingMs: 15,       // Audio padding (default: 15ms)
  sampleRate: 48000,        // Sample rate (default: 48000)
  debugMode: false          // Enable debug logging
});
```

## Fade Duration Guidelines

| Duration | Use Case |
|----------|----------|
| 10-20ms  | Very subtle, fast speech |
| 20-30ms  | **Recommended** - Good balance |
| 30-50ms  | Smoother, noticeable on close words |
| 50ms+    | May blur word boundaries |

## API Reference

### AudioCrossfadeManager

```typescript
class AudioCrossfadeManager {
  // Initialize Web Audio routing (call on user interaction)
  initialize(mediaElement: HTMLMediaElement): boolean
  
  // Seek with crossfade (fade-out, seek, fade-in)
  seekWithCrossfade(seekTimeSeconds: number, mediaElement: HTMLMediaElement): Promise<void>
  
  // Direct seek without crossfade
  seekDirect(seekTimeSeconds: number, mediaElement: HTMLMediaElement): void
  
  // Check if initialized and ready
  isReady(): boolean
  
  // Update fade duration
  setFadeDuration(durationMs: number): void
  
  // Cleanup
  dispose(): void
}
```

### OfflineAudioRenderer

```typescript
class OfflineAudioRenderer {
  // Decode audio from URL
  decodeAudio(audioUrl: string): Promise<AudioBuffer>
  
  // Render timeline with crossfades
  renderTimeline(
    sourceBuffer: AudioBuffer, 
    renderSegments: RenderSegment[]
  ): Promise<AudioBuffer>
  
  // Export as WAV
  exportAsWav(audioBuffer: AudioBuffer): Blob
  
  // Update configuration
  updateConfig(config: Partial<RenderConfig>): void
}
```

### Utility Functions

```typescript
// Convert PlaybackSegment[] to RenderSegment[] with output timing
playbackSegmentsToRenderSegments(
  playbackSegments: PlaybackSegment[]
): RenderSegment[]

// Apply fade curves to AudioBuffer (for advanced use)
applyFadeIn(buffer: AudioBuffer, channel: number, startSample: number, fadeSamples: number): void
applyFadeOut(buffer: AudioBuffer, channel: number, startSample: number, fadeSamples: number): void

// Schedule realtime fade on GainNode
scheduleFade(gainNode: GainNode, startValue: number, endValue: number, durationSeconds: number): void
```

## Integration with TranscriptViewer

The TranscriptViewer component automatically:

1. Creates an `AudioCrossfadeManager` on mount
2. Initializes Web Audio routing on first play event
3. Detects segment boundaries during playback
4. Applies crossfades when jumping to non-contiguous segments
5. Uses direct seeks for continuous sequences
6. Cleans up on unmount

**No configuration needed** - works out of the box.

## Performance Notes

- **Realtime fades**: Negligible overhead, imperceptible latency (~25ms)
- **Offline rendering**: 
  - Decode time: ~1-2x realtime
  - Render time: Usually faster than realtime
  - Memory: ~10-20MB per minute of audio

## Browser Compatibility

- **Web Audio API**: All modern browsers (Chrome, Firefox, Safari, Edge)
- **OfflineAudioContext**: All modern browsers
- **AudioContext autoplay**: Requires user interaction (handled automatically)

## Debugging

Enable debug mode to see detailed logging:

```typescript
// Realtime
const manager = new AudioCrossfadeManager({ debugMode: true });

// Offline
const renderer = new OfflineAudioRenderer({ debugMode: true });
```

Logs will appear in the browser console with `[Audio]` or `[Render]` prefixes.

## Future Enhancements

Potential improvements (not in current implementation):

- [ ] Phoneme-aware crossfades (fade during consonants, not vowels)
- [ ] Adaptive fade duration based on speech rate
- [ ] Loudness normalization across segments
- [ ] Spectral smoothing for better frequency transitions
- [ ] UI controls for fade duration adjustment
- [ ] Visual waveform preview with fade regions highlighted

## Example Workflow

```typescript
// 1. User edits transcript (delete/reorder words)
const editedWords = [...]; // Modified word list

// 2. Build playback segments (automatic in TranscriptViewer)
const segments = buildPlaybackSegments(editedWords);

// 3. Preview with realtime fades (automatic)
//    AudioCrossfadeManager handles this transparently

// 4. Export high-quality audio
const renderer = new OfflineAudioRenderer();
const sourceBuffer = await renderer.decodeAudio(videoUrl);
const renderSegments = playbackSegmentsToRenderSegments(segments);
const finalAudio = await renderer.renderTimeline(sourceBuffer, renderSegments);
const wavFile = renderer.exportAsWav(finalAudio);

// 5. Upload or mux with video (server-side)
//    uploadAudio(wavFile) or muxVideoAudio(videoFile, wavFile)
```

## References

- [Web Audio API Spec](https://www.w3.org/TR/webaudio/)
- [Equal-power crossfades](https://www.musicdsp.org/en/latest/Synthesis/56-equal-power-crossfade.html)
- [OfflineAudioContext](https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext)
