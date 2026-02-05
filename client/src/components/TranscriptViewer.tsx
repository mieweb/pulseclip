import type { FC, RefObject } from 'react';
import { useEffect, useState } from 'react';
import type { Transcript, TranscriptWord } from '../types';
import './TranscriptViewer.scss';

interface TranscriptViewerProps {
  transcript: Transcript;
  mediaRef: RefObject<HTMLAudioElement | HTMLVideoElement>;
  showRaw?: boolean;
  rawData?: any;
}

export const TranscriptViewer: FC<TranscriptViewerProps> = ({
  transcript,
  mediaRef,
  showRaw = false,
  rawData,
}) => {
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;

    const handleTimeUpdate = () => {
      const timeMs = media.currentTime * 1000;

      // Find active word
      const index = transcript.words.findIndex(
        (word) => timeMs >= word.startMs && timeMs <= word.endMs
      );
      setActiveWordIndex(index >= 0 ? index : null);
    };

    media.addEventListener('timeupdate', handleTimeUpdate);
    return () => media.removeEventListener('timeupdate', handleTimeUpdate);
  }, [transcript.words, mediaRef]);

  const handleWordClick = (word: TranscriptWord) => {
    const media = mediaRef.current;
    if (media) {
      media.currentTime = word.startMs / 1000;
      media.play();
    }
  };

  if (showRaw && rawData) {
    return (
      <div className="transcript-viewer">
        <div className="transcript-viewer__raw">
          <h3>Raw Provider Response</h3>
          <pre>{JSON.stringify(rawData, null, 2)}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="transcript-viewer">
      <div className="transcript-viewer__header">
        <h3>Transcript</h3>
        <div className="transcript-viewer__meta">
          <span>{transcript.words.length} words</span>
          {transcript.speakers && (
            <span>{transcript.speakers.length} speakers</span>
          )}
          <span>{Math.round(transcript.durationMs / 1000)}s</span>
        </div>
      </div>

      <div className="transcript-viewer__content">
        {transcript.words.map((word, index) => (
          <span
            key={index}
            className={`transcript-viewer__word ${
              index === activeWordIndex ? 'transcript-viewer__word--active' : ''
            }`}
            onClick={() => handleWordClick(word)}
            title={`${word.startMs}ms - ${word.endMs}ms${
              word.confidence ? ` (${Math.round(word.confidence * 100)}%)` : ''
            }`}
          >
            {word.text}{' '}
          </span>
        ))}
      </div>
    </div>
  );
};
