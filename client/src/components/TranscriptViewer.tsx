import type { FC, RefObject } from 'react';
import { useEffect, useState, useCallback, useRef } from 'react';
import type { Transcript, TranscriptWord, EditableWord, PlaybackSegment } from '../types';
import { debug } from '../debug';
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

/** Clipboard data for cut/paste operations */
interface ClipboardData {
  words: EditableWord[];
  operation: 'cut' | 'copy';
}

/**
 * Builds playback segments from the edited word list.
 * Consecutive words in original order are merged into single segments.
 */
function buildPlaybackSegments(editedWords: EditableWord[]): PlaybackSegment[] {
  const activeWords = editedWords.filter(w => !w.deleted);
  if (activeWords.length === 0) return [];

  const segments: PlaybackSegment[] = [];
  let currentSegment: PlaybackSegment | null = null;
  let lastOriginalIndex = -2; // Use -2 so first word always starts new segment

  for (let i = 0; i < editedWords.length; i++) {
    const ew = editedWords[i];
    if (ew.deleted) continue;

    // Check if this word is consecutive to the previous in the original
    const isConsecutive = ew.originalIndex === lastOriginalIndex + 1;

    if (currentSegment && isConsecutive) {
      // Extend current segment
      currentSegment.endMs = ew.word.endMs;
      currentSegment.editedIndices.push(i);
    } else {
      // Start new segment
      if (currentSegment) {
        segments.push(currentSegment);
      }
      currentSegment = {
        startMs: ew.word.startMs,
        endMs: ew.word.endMs,
        editedIndices: [i],
      };
    }

    lastOriginalIndex = ew.originalIndex;
  }

  if (currentSegment) {
    segments.push(currentSegment);
  }

  return segments;
}

/** Initialize editable words from transcript */
function initEditableWords(transcript: Transcript): EditableWord[] {
  return transcript.words.map((word, index) => ({
    originalIndex: index,
    word,
    deleted: false,
  }));
}

export const TranscriptViewer: FC<TranscriptViewerProps> = ({
  transcript,
  mediaRef,
  showRaw = false,
  rawData,
}) => {
  // Edit mode state
  const [editedWords, setEditedWords] = useState<EditableWord[]>(() => 
    initEditableWords(transcript)
  );
  const [clipboard, setClipboard] = useState<ClipboardData | null>(null);
  const [hasEdits, setHasEdits] = useState(false);
  
  // Playback state
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);
  const [cursorIndex, setCursorIndex] = useState<number>(0);
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [selection, setSelection] = useState<SelectionRange | null>(null);
  const [isSeeking, setIsSeeking] = useState(false);
  const [isPlayingSequence, setIsPlayingSequence] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const userSetCursor = useRef<number | null>(null);
  const wordPlaybackEndMs = useRef<number | null>(null);
  
  // Segment playback refs
  const playbackSegments = useRef<PlaybackSegment[]>([]);
  const currentSegmentIndex = useRef<number>(0);

  // Reset edited words when transcript changes
  useEffect(() => {
    setEditedWords(initEditableWords(transcript));
    setHasEdits(false);
    setCursorIndex(0);
    setSelection(null);
    setSelectionAnchor(null);
  }, [transcript]);

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

      // Handle segment-based playback (for edited/reordered content)
      if (isPlayingSequence && playbackSegments.current.length > 0) {
        const currentSeg = playbackSegments.current[currentSegmentIndex.current];
        if (currentSeg && timeMs >= currentSeg.endMs) {
          // Move to next segment
          const nextIndex = currentSegmentIndex.current + 1;
          if (nextIndex < playbackSegments.current.length) {
            const nextSeg = playbackSegments.current[nextIndex];
            debug('Segment', `Jumping to segment ${nextIndex}: ${nextSeg.startMs}ms`);
            currentSegmentIndex.current = nextIndex;
            media.currentTime = nextSeg.startMs / 1000;
          } else {
            // End of all segments
            debug('Segment', 'Sequence playback complete');
            media.pause();
            setIsPlayingSequence(false);
            playbackSegments.current = [];
            currentSegmentIndex.current = 0;
          }
        }
      }

      // Stop playback if we've reached the end of single-word playback
      if (wordPlaybackEndMs.current !== null && timeMs >= wordPlaybackEndMs.current) {
        debug('Playback', `Stopping at word end (${wordPlaybackEndMs.current}ms)`);
        media.pause();
        wordPlaybackEndMs.current = null;
      }

      // Find active word in edited list (based on current playback time)
      const editedIndex = editedWords.findIndex(
        (ew) => !ew.deleted && timeMs >= ew.word.startMs && timeMs < ew.word.endMs
      );
      if (editedIndex !== activeWordIndex) {
        const ew = editedIndex >= 0 ? editedWords[editedIndex] : null;
        debug('Playback', `Active word: ${ew?.word.text ?? 'none'} (index: ${editedIndex}, time: ${timeMs.toFixed(0)}ms)`);
      }
      setActiveWordIndex(editedIndex >= 0 ? editedIndex : null);
    };

    media.addEventListener('timeupdate', handleTimeUpdate);
    return () => media.removeEventListener('timeupdate', handleTimeUpdate);
  }, [editedWords, mediaRef, isPlayingSequence]);

  const handleWordClick = (word: TranscriptWord, index: number, e: React.MouseEvent) => {
    debug('Click', `Word: "${word.text}" (index: ${index}, start: ${word.startMs}ms)`);
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
      
      // Stop current playback, seek to word, and play just that word
      const media = mediaRef.current;
      if (media) {
        debug('Seek', `Seeking to ${word.startMs}ms ("${word.text}"), will stop at ${word.endMs}ms`);
        media.pause();
        media.currentTime = word.startMs / 1000;
        wordPlaybackEndMs.current = word.endMs;
        media.play().catch((err) => {
          // AbortError is expected when quickly clicking between words
          if (err.name !== 'AbortError') {
            console.error('[TranscriptViewer] Play error:', err);
          }
        });
      }
    }
  };

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const wordCount = editedWords.length;
    if (wordCount === 0) return;

    let newIndex = cursorIndex;
    let handled = false;

    // Delete/Backspace - toggle deleted state for selection or cursor word
    if (e.key === 'Delete' || e.key === 'Backspace') {
      setEditedWords(prev => {
        const updated = [...prev];
        if (selection) {
          // Toggle deleted state for all selected words
          for (let i = selection.start; i <= selection.end; i++) {
            updated[i] = { ...updated[i], deleted: !updated[i].deleted };
          }
        } else {
          // Toggle deleted state for cursor word
          updated[cursorIndex] = { ...updated[cursorIndex], deleted: !updated[cursorIndex].deleted };
        }
        return updated;
      });
      setHasEdits(true);
      debug('Edit', `Toggled deleted state for ${selection ? `words ${selection.start}-${selection.end}` : `word ${cursorIndex}`}`);
      handled = true;
    }
    // Cut - Cmd/Ctrl+X
    else if ((e.metaKey || e.ctrlKey) && e.key === 'x') {
      if (selection) {
        const cutWords = editedWords.slice(selection.start, selection.end + 1);
        setClipboard({ words: cutWords, operation: 'cut' });
        setEditedWords(prev => {
          const updated = [...prev];
          // Mark cut words as deleted
          for (let i = selection.start; i <= selection.end; i++) {
            updated[i] = { ...updated[i], deleted: true };
          }
          return updated;
        });
        setHasEdits(true);
        debug('Edit', `Cut ${cutWords.length} words`);
        handled = true;
      }
    }
    // Paste - Cmd/Ctrl+V
    else if ((e.metaKey || e.ctrlKey) && e.key === 'v' && clipboard) {
      setEditedWords(prev => {
        const updated = [...prev];
        // Insert clipboard words at cursor position
        const insertIndex = cursorIndex + 1;
        const wordsToInsert = clipboard.words.map(w => ({ ...w, deleted: false }));
        updated.splice(insertIndex, 0, ...wordsToInsert);
        return updated;
      });
      setHasEdits(true);
      debug('Edit', `Pasted ${clipboard.words.length} words at position ${cursorIndex + 1}`);
      // Move cursor to end of pasted content
      setCursorIndex(cursorIndex + clipboard.words.length);
      setSelection(null);
      setSelectionAnchor(null);
      handled = true;
    }
    // Undo all edits - Cmd/Ctrl+Z (simple reset for now)
    else if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      setEditedWords(initEditableWords(transcript));
      setHasEdits(false);
      setCursorIndex(0);
      setSelection(null);
      setSelectionAnchor(null);
      debug('Edit', 'Reset all edits');
      handled = true;
    }
    else if (e.key === 'ArrowLeft') {
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
        let targetRowTop: number | null = null;
        
        for (let i = cursorIndex + direction; i >= 0 && i < wordCount; i += direction) {
          const el = contentRef.current?.querySelector(`[data-word-index="${i}"]`) as HTMLElement;
          if (!el) continue;
          
          const rect = el.getBoundingClientRect();
          const isOnDifferentRow = direction === -1 
            ? rect.bottom <= currentRect.top 
            : rect.top >= currentRect.bottom;
          
          if (isOnDifferentRow) {
            // First word on a different row - this establishes our target row
            if (targetRowTop === null) {
              targetRowTop = rect.top;
            }
            
            // Only consider words on the same row as the first different-row word we found
            const isSameTargetRow = Math.abs(rect.top - targetRowTop) < 5; // 5px tolerance
            if (isSameTargetRow) {
              const centerX = rect.left + rect.width / 2;
              const distance = Math.abs(centerX - currentCenterX);
              
              if (distance < bestDistance) {
                bestDistance = distance;
                bestMatch = i;
              }
            } else {
              // We've moved past the target row, stop searching
              break;
            }
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
      const ew = editedWords[cursorIndex];
      const media = mediaRef.current;
      if (media && ew && !ew.deleted) {
        if (media.paused) {
          // If edited, play the edited sequence; otherwise play from cursor word
          if (hasEdits) {
            // Build segments and start sequence playback
            const segments = buildPlaybackSegments(editedWords);
            if (segments.length > 0) {
              // Find which segment contains the cursor
              let startSegmentIdx = 0;
              for (let i = 0; i < segments.length; i++) {
                if (segments[i].editedIndices.includes(cursorIndex)) {
                  startSegmentIdx = i;
                  break;
                }
              }
              playbackSegments.current = segments;
              currentSegmentIndex.current = startSegmentIdx;
              setIsPlayingSequence(true);
              debug('Segment', `Starting sequence playback from segment ${startSegmentIdx}`);
              media.currentTime = segments[startSegmentIdx].startMs / 1000;
              media.play().catch((err) => {
                if (err.name !== 'AbortError') {
                  console.error('[TranscriptViewer] Play error:', err);
                }
              });
            }
          } else {
            // Normal playback from cursor
            debug('Spacebar', `Play from "${ew.word.text}" (${ew.word.startMs}ms)`);
            media.currentTime = ew.word.startMs / 1000;
            media.play().catch((err) => {
              if (err.name !== 'AbortError') {
                console.error('[TranscriptViewer] Play error:', err);
              }
            });
          }
        } else {
          // Pause playback
          debug('Spacebar', `Pause at ${(media.currentTime * 1000).toFixed(0)}ms`);
          media.pause();
          setIsPlayingSequence(false);
        }
      }
      handled = true;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      setCursorIndex(newIndex);

      if (e.shiftKey && e.key !== 'Delete' && e.key !== 'Backspace') {
        // Handle selection (not for delete operations)
        const anchor = selectionAnchor ?? cursorIndex;
        if (selectionAnchor === null) {
          setSelectionAnchor(cursorIndex);
        }
        setSelection({
          start: Math.min(anchor, newIndex),
          end: Math.max(anchor, newIndex),
        });
      } else if (!e.metaKey && !e.ctrlKey) {
        // Clear selection when moving without shift (but not for cut/paste)
        setSelection(null);
        setSelectionAnchor(null);
      }

      // Scroll cursor into view
      const wordElement = contentRef.current?.querySelector(`[data-word-index="${newIndex}"]`);
      wordElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [cursorIndex, selectionAnchor, editedWords, mediaRef, hasEdits, clipboard, selection, transcript]);

  const isWordSelected = (index: number): boolean => {
    if (!selection) return false;
    return index >= selection.start && index <= selection.end;
  };

  const getSelectedText = (): string => {
    if (!selection) return '';
    return editedWords
      .slice(selection.start, selection.end + 1)
      .filter(ew => !ew.deleted)
      .map(ew => ew.word.text)
      .join(' ');
  };

  // Handle copy
  const handleCopy = useCallback((e: React.ClipboardEvent) => {
    const selectedText = getSelectedText();
    if (selectedText) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', selectedText);
    }
  }, [selection, editedWords]);

  // Count active (non-deleted) words
  const activeWordCount = editedWords.filter(ew => !ew.deleted).length;
  const deletedWordCount = editedWords.length - activeWordCount;

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
        <h3>Transcript {hasEdits && <span className="transcript-viewer__edited-badge">Edited</span>}</h3>
        <div className="transcript-viewer__meta">
          <span>{activeWordCount} words</span>
          {deletedWordCount > 0 && (
            <span className="transcript-viewer__deleted-count">
              {deletedWordCount} deleted
            </span>
          )}
          {transcript.speakers && (
            <span>{transcript.speakers.length} speakers</span>
          )}
          <span>{Math.round(transcript.durationMs / 1000)}s</span>
        </div>
      </div>

      {hasEdits && (
        <div className="transcript-viewer__edit-bar">
          <span className="transcript-viewer__edit-hint">
            Press Del to toggle delete • ⌘X to cut • ⌘V to paste • ⌘Z to reset
          </span>
          <button
            className="transcript-viewer__play-edited-btn"
            onClick={() => {
              const segments = buildPlaybackSegments(editedWords);
              if (segments.length > 0 && mediaRef.current) {
                playbackSegments.current = segments;
                currentSegmentIndex.current = 0;
                setIsPlayingSequence(true);
                mediaRef.current.currentTime = segments[0].startMs / 1000;
                mediaRef.current.play();
              }
            }}
            disabled={activeWordCount === 0}
          >
            ▶ Play Edited
          </button>
        </div>
      )}

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
        {editedWords.map((ew, index) => {
          const isActive = index === activeWordIndex;
          const isCursor = index === cursorIndex;
          const isSelected = isWordSelected(index);
          const isDeleted = ew.deleted;
          
          return (
            <span
              key={`${ew.originalIndex}-${index}`}
              id={`word-${index}`}
              data-word-index={index}
              className={`transcript-viewer__word${
                isActive ? ' transcript-viewer__word--active' : ''
              }${isCursor ? ' transcript-viewer__word--cursor' : ''
              }${isSelected ? ' transcript-viewer__word--selected' : ''
              }${isDeleted ? ' transcript-viewer__word--deleted' : ''}`}
              onClick={(e) => handleWordClick(ew.word, index, e)}
              role="option"
              aria-selected={isSelected || isCursor}
              title={`${ew.word.startMs}ms - ${ew.word.endMs}ms${
                ew.word.confidence ? ` (${Math.round(ew.word.confidence * 100)}%)` : ''
              }${isDeleted ? ' [DELETED]' : ''}`}
            >
              {ew.word.text}{' '}
            </span>
          );
        })}
      </div>
    </div>
  );
};
