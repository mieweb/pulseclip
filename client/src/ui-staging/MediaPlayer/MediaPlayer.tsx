import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Button } from '@mieweb/ui/components/Button';

// ============================================================================
// Types & Interfaces
// ============================================================================

export type MediaPlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export type MediaKind = 'video' | 'audio';

/** Ref handle for controlling MediaPlayer programmatically */
export interface MediaPlayerRef {
  /** Seek to a specific time in milliseconds */
  seekToMs: (timeMs: number) => void;
  /** Start playback */
  play: () => void;
  /** Pause playback */
  pause: () => void;
  /** Get current playback time in milliseconds */
  getCurrentTimeMs: () => number;
  /** Get total duration in milliseconds */
  getDurationMs: () => number;
  /** Whether playback is currently paused */
  isPaused: () => boolean;
  /** Set playback speed multiplier */
  setPlaybackRate: (rate: number) => void;
  /**
   * The underlying media element.
   * Escape hatch for host integrations (e.g. thumbnail capture); prefer the
   * typed methods above for playback control.
   */
  mediaElement: HTMLVideoElement | HTMLAudioElement | null;
}

export interface MediaPlayerProps extends VariantProps<typeof mediaPlayerVariants> {
  /** Media source URL */
  src: string;
  /** Force the media kind; when omitted it is inferred from the src extension */
  kind?: MediaKind;
  /** Whether to show native controls (default true) */
  controls?: boolean;
  /** Callback when playback state changes */
  onStateChange?: (state: MediaPlayerState) => void;
  /** Callback when playback ends */
  onEnded?: () => void;
  /** Callback when an error occurs */
  onError?: (error: Error) => void;
  /** Callback on time updates (ms) */
  onTimeUpdate?: (currentTimeMs: number, durationMs: number) => void;
  /** Additional class name */
  className?: string;
  /** Accessible label for the media element */
  'aria-label'?: string;
  /**
   * Transitional: exposes the raw media element to legacy consumers.
   * Will be removed once all consumers use MediaPlayerRef.
   */
  mediaElementRef?: React.RefObject<HTMLVideoElement | HTMLAudioElement | null>;
}

// ============================================================================
// Variants
// ============================================================================

const mediaPlayerVariants = cva('flex h-full w-full items-center justify-center', {
  variants: {
    variant: {
      plain: '',
      card: 'rounded-xl border border-border bg-card text-card-foreground p-2',
    },
  },
  defaultVariants: {
    variant: 'plain',
  },
});

// ============================================================================
// Helpers
// ============================================================================

const VIDEO_EXTENSIONS = /\.(mp4|mov|avi|webm|mkv|m4v)(\?.*)?$/i;

/** Infer media kind from a URL's file extension; defaults to audio */
export function inferMediaKind(src: string): MediaKind {
  return VIDEO_EXTENSIONS.test(src) ? 'video' : 'audio';
}

// ============================================================================
// Component
// ============================================================================

/**
 * Media playback surface for audio and video with a shared imperative handle.
 *
 * Renders a native `<video>` or `<audio>` element (kind inferred from the src
 * extension unless forced) with themed error/retry handling. Playback is
 * controlled through {@link MediaPlayerRef} — consumers should not reach into
 * the DOM element directly.
 */
export const MediaPlayer = React.forwardRef<MediaPlayerRef, MediaPlayerProps>(
  (
    {
      src,
      kind,
      controls = true,
      variant,
      onStateChange,
      onEnded,
      onError,
      onTimeUpdate,
      className,
      'aria-label': ariaLabel,
      mediaElementRef,
    },
    ref
  ) => {
    const elementRef = React.useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const resolvedKind = kind ?? inferMediaKind(src);

    const setElement = React.useCallback(
      (el: HTMLVideoElement | HTMLAudioElement | null) => {
        elementRef.current = el;
        if (mediaElementRef) {
          (mediaElementRef as React.MutableRefObject<typeof el>).current = el;
        }
      },
      [mediaElementRef]
    );

    React.useImperativeHandle(
      ref,
      (): MediaPlayerRef => ({
        seekToMs: (timeMs) => {
          if (elementRef.current) elementRef.current.currentTime = timeMs / 1000;
        },
        play: () => {
          void elementRef.current?.play();
        },
        pause: () => {
          elementRef.current?.pause();
        },
        getCurrentTimeMs: () => (elementRef.current?.currentTime ?? 0) * 1000,
        getDurationMs: () => {
          const d = elementRef.current?.duration;
          return d && Number.isFinite(d) ? d * 1000 : 0;
        },
        isPaused: () => elementRef.current?.paused ?? true,
        setPlaybackRate: (rate) => {
          if (elementRef.current) elementRef.current.playbackRate = rate;
        },
        get mediaElement() {
          return elementRef.current;
        },
      }),
      []
    );

    const handleError = React.useCallback(() => {
      setError('Unable to load media. The server may be unavailable.');
      onStateChange?.('error');
      onError?.(new Error(`Failed to load media: ${src}`));
    }, [onError, onStateChange, src]);

    const handleRetry = React.useCallback(() => {
      setError(null);
      elementRef.current?.load();
    }, []);

    const sharedMediaProps = {
      src,
      controls,
      onError: handleError,
      onCanPlay: () => {
        setError(null);
        onStateChange?.('idle');
      },
      onPlay: () => onStateChange?.('playing'),
      onPause: () => onStateChange?.('paused'),
      onEnded: () => {
        onStateChange?.('paused');
        onEnded?.();
      },
      onTimeUpdate: () => {
        const el = elementRef.current;
        if (el && onTimeUpdate) {
          const duration = Number.isFinite(el.duration) ? el.duration : 0;
          onTimeUpdate(el.currentTime * 1000, duration * 1000);
        }
      },
      'aria-label': ariaLabel,
    };

    if (error) {
      return (
        <div className={mediaPlayerVariants({ variant, className })}>
          <div
            role="alert"
            className="flex min-h-36 flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-8 text-center"
          >
            <p className="m-0 text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={handleRetry}>
              Retry
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className={mediaPlayerVariants({ variant, className })}>
        {resolvedKind === 'video' ? (
          <video
            ref={setElement as React.Ref<HTMLVideoElement>}
            playsInline
            className="h-auto max-h-full w-auto max-w-full object-contain"
            {...sharedMediaProps}
          />
        ) : (
          <audio
            ref={setElement as React.Ref<HTMLAudioElement>}
            className="my-4 w-[90%] max-w-lg"
            {...sharedMediaProps}
          />
        )}
      </div>
    );
  }
);

MediaPlayer.displayName = 'MediaPlayer';
