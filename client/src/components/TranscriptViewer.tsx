import type { FC, RefObject } from 'react';
import { useEffect, useState, useCallback, useRef } from 'react';
import type { Transcript, TranscriptWord } from '../types';
import './TranscriptViewer.scss';

interface TranscriptViewerProps {
  transcript: Transcript;
  mediaRef: RefObject<HTMLAudioElement | HTMLVideoElement>;
  showRaw?: boolean;
  rawData?: any;
}

interface SelectionRange {
  start: number;
  end: number;
}

export const TranscriptViewer: FC<TranscriptViewerProps> = ({
  transcript,
  mediaRef,
  showRaw = false,
  rawData,
}) => {
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);
  const [cursorIndex, setCursorIndex] = useState<number>(0);
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [selection, setSelection] = useState<SelectionRange | null>(null);
  const [isSeeking, setIsSeeking] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const userSetCursor = useRef<number | null>(null);

  // Sync cursor with active word when media is playing (not seeking)
  useEffect(() => {
    // Don't sync if user just clicked a word (let the seek complete first)
    if (userSetCursor.current !== null) {
      return;
    }
    if (!isSeeking && activeWordIndex !== null && activeWordIndex >= 0) {
      setCursorIndex(activeWordIndex);
      setSelection(null);
      setSelectionAnchor(null);
    }
  }, [activeWordIndex, isSeeking, transcript.words]);

  // Auto-focus the transcript content for keyboard navigation
  useEffect(() => {
    if (!showRaw && contentRef.current) {
      contentRef.current.focus();
    }
  }, [showRaw, transcript]);

  // Track seeking state
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;

    const handleSeeking = () => {
      setIsSeeking(true);
    };
    const handleSeeked = () => {
      setIsSeeking(false);
      // Clear user cursor lock after seek completes
      userSetCursor.current = null;
    };

    media.addEventListener('seeking', handleSeeking);
    media.addEventListener('seeked', handleSeeked);
    return () => {
      media.removeEventListener('seeking', handleSeeking);
      media.removeEventListener('seeked', handleSeeked);
    };
  }, [mediaRef]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;

    const handleTimeUpdate = () => {
      const timeMs = media.currentTime * 1000;

      // Find active word (end time is exclusive to handle adjacent words)
      const index = transcript.words.findIndex(
        (word) => timeMs >= word.startMs && timeMs < word.endMs
      );
      setActiveWordIndex(index >= 0 ? index : null);
    };

    media.addEventListener('timeupdate', handleTimeUpdate);
    return () => media.removeEventListener('timeupdate', handleTimeUpdate);
  }, [transcript.words, mediaRef]);

  const handleWordClick = (word: TranscriptWord, index: number, e: React.MouseEvent) => {
    setCursorIndex(index);
    userSetCursor.current = index;
    
    if (e.shiftKey && selectionAnchor !== null) {
      // Extend selection with shift+click
      setSelection({
        start: Math.min(selectionAnchor, index),
        end: Math.max(selectionAnchor, index),
      });
    } else {
      // Clear selection and set new anchor
      setSelectionAnchor(index);
      setSelection(null);
      
      // Seek to word and play
      const media = mediaRef.current;
      if (media) {
        // Pause first to avoid "play() interrupted" errors
        media.pause();
        media.currentTime = word.startMs / 1000;
        media.play().catch((err) => {
          // Ignore AbortError which happens when play is interrupted
          if (err.name !== 'AbortError') {
            console.error('[TranscriptViewer] Play error:', err);
          }
        });
      }
    }
  };

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const wordCount = transcript.words.length;
    if (wordCount === 0) return;

    let newIndex = cursorIndex;
    let handled = false;

    if (e.key === 'ArrowLeft') {
      newIndex = Math.max(0, cursorIndex - 1);
      handled = true;
    } else if (e.key === 'ArrowRight') {
      newIndex = Math.min(wordCount - 1, cursorIndex + 1);
      handled = true;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Find word on previous/next visual row
      const currentElement = contentRef.current?.querySelector(`[data-word-index="${cursorIndex}"]`) as HTMLElement;
      if (currentElement) {
        const currentRect = currentElement.getBoundingClientRect();
        const currentCenterX = currentRect.left + currentRect.width / 2;
        
        // Search for word on adjacent row
        const direction = e.key === 'ArrowUp' ? -1 : 1;
        let bestMatch = cursorIndex;
        let bestDistance = Infinity;
        let foundDifferentRow = false;
        
        for (let i = cursorIndex + direction; i >= 0 && i < wordCount; i += direction) {
          const el = contentRef.current?.querySelector(`[data-word-index="${i}"]`) as HTMLElement;
          if (!el) continue;
          
          const rect = el.getBoundingClientRect();
          const isOnDifferentRow = direction === -1 
            ? rect.bottom <= currentRect.top 
            : rect.top >= currentRect.bottom;
          
          if (isOnDifferentRow) {
            foundDifferentRow = true;
            const centerX = rect.left + rect.width / 2;
            const distance = Math.abs(centerX - currentCenterX);
            
            if (distance < bestDistance) {
              bestDistance = distance;
              bestMatch = i;
            }
          } else if (foundDifferentRow) {
            // We've moved past the adjacent row, stop searching
            break;
          }
        }
        
        newIndex = bestMatch;
      }
      handled = true;
    } else if (e.key === 'Home') {
      newIndex = 0;
      handled = true;
    } else if (e.key === 'End') {
      newIndex = wordCount - 1;
      handled = true;
    } else if (e.key === 'Enter' || e.key === ' ') {
      // Toggle play/pause from cursor position
      const word = transcript.words[cursorIndex];
      const media = mediaRef.current;
      if (media && word) {
        if (media.paused) {
          // Seek to cursor word and play
          media.currentTime = word.startMs / 1000;
          media.play().catch((err) => {
            if (err.name !== 'AbortError') {
              console.error('[TranscriptViewer] Play error:', err);
            }
          });
        } else {
          // Pause playback
          media.pause();
        }
      }
      handled = true;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      setCursorIndex(newIndex);

      if (e.shiftKey) {
        // Handle selection
        const anchor = selectionAnchor ?? cursorIndex;
        if (selectionAnchor === null) {
          setSelectionAnchor(cursorIndex);
        }
        setSelection({
          start: Math.min(anchor, newIndex),
          end: Math.max(anchor, newIndex),
        });
      } else {
        // Clear selection when moving without shift
        setSelection(null);
        setSelectionAnchor(null);
      }

      // Scroll cursor into view
      const wordElement = contentRef.current?.querySelector(`[data-word-index="${newIndex}"]`);
      wordElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [cursorIndex, selectionAnchor, transcript.words, mediaRef]);

  const isWordSelected = (index: number): boolean => {
    if (!selection) return false;
    return index >= selection.start && index <= selection.end;
  };

  const getSelectedText = (): string => {
    if (!selection) return '';
    return transcript.words
      .slice(selection.start, selection.end + 1)
      .map(w => w.text)
      .join(' ');
  };

  // Handle copy
  const handleCopy = useCallback((e: React.ClipboardEvent) => {
    const selectedText = getSelectedText();
    if (selectedText) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', selectedText);
    }
  }, [selection, transcript.words]);

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

      <div 
        className="transcript-viewer__content"
        ref={contentRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onCopy={handleCopy}
        role="listbox"
        aria-label="Transcript words"
        aria-activedescendant={`word-${cursorIndex}`}
      >
        {transcript.words.map((word, index) => {
          const isActive = index === activeWordIndex;
          const isCursor = index === cursorIndex;
          const isSelected = isWordSelected(index);
          
          return (
            <span
              key={index}
              id={`word-${index}`}
              data-word-index={index}
              className={`transcript-viewer__word${
                isActive ? ' transcript-viewer__word--active' : ''
              }${isCursor ? ' transcript-viewer__word--cursor' : ''
              }${isSelected ? ' transcript-viewer__word--selected' : ''}`}
              onClick={(e) => handleWordClick(word, index, e)}
              role="option"
              aria-selected={isSelected || isCursor}
              title={`${word.startMs}ms - ${word.endMs}ms${
                word.confidence ? ` (${Math.round(word.confidence * 100)}%)` : ''
              }`}
            >
              {word.text}{' '}
            </span>
          );
        })}
      </div>
    </div>
  );
};
