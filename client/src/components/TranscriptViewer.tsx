import type { FC, RefObject } from 'react';
import { useEffect, useState, useCallback, useRef } from 'react';
import type { Transcript, TranscriptWord, EditableWord, PlaybackSegment } from '../types';
import { debug } from '../debug';
import './TranscriptViewer.scss';

/** Default filler words to remove */
const DEFAULT_FILLER_WORDS = [
  'um', 'uh', 'umm', 'uhh', 'uh-huh', 'mm-hmm', 'hmm', 'hm',
  'er', 'err', 'ah', 'ahh', 'eh', 'oh', 'ooh',
  'like', 'you know', 'i mean', 'so', 'well', 'actually',
  'basically', 'literally', 'right', 'okay', 'ok',
];

/** Props for the filler words modal */
interface FillerWordsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApply: (fillerWords: string[]) => void;
  matchingCounts: Map<string, number>;
}

/** Modal component for selecting filler words to remove */
const FillerWordsModal: FC<FillerWordsModalProps> = ({ isOpen, onClose, onApply, matchingCounts }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFillers, setSelectedFillers] = useState<Set<string>>(new Set(DEFAULT_FILLER_WORDS));
  const [customWord, setCustomWord] = useState('');
  const modalRef = useRef<HTMLDivElement>(null);

  // Filter filler words based on search
  const filteredFillers = DEFAULT_FILLER_WORDS.filter(word =>
    word.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Get custom words that have been added
  const customFillers = Array.from(selectedFillers).filter(
    word => !DEFAULT_FILLER_WORDS.includes(word)
  ).filter(word =>
    word.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const toggleFiller = (word: string) => {
    setSelectedFillers(prev => {
      const next = new Set(prev);
      if (next.has(word)) {
        next.delete(word);
      } else {
        next.add(word);
      }
      return next;
    });
  };

  const handleAddCustom = () => {
    const trimmed = customWord.trim().toLowerCase();
    if (trimmed && !selectedFillers.has(trimmed)) {
      setSelectedFillers(prev => new Set([...prev, trimmed]));
      setCustomWord('');
    }
  };

  const handleApply = () => {
    onApply(Array.from(selectedFillers));
    onClose();
  };

  const selectAll = () => {
    setSelectedFillers(new Set([...DEFAULT_FILLER_WORDS, ...customFillers]));
  };

  const selectNone = () => {
    setSelectedFillers(new Set());
  };

  // Calculate total matches
  const totalMatches = Array.from(selectedFillers).reduce(
    (sum, word) => sum + (matchingCounts.get(word) || 0),
    0
  );

  // Close on escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose]);

  // Focus trap and click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="filler-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="filler-modal-title">
      <div className="filler-modal" ref={modalRef}>
        <div className="filler-modal__header">
          <h3 id="filler-modal-title">Remove Filler Words</h3>
          <button className="filler-modal__close" onClick={onClose} aria-label="Close modal">
            ×
          </button>
        </div>

        <div className="filler-modal__search">
          <input
            type="text"
            placeholder="Search filler words..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            aria-label="Search filler words"
          />
        </div>

        <div className="filler-modal__actions-row">
          <button onClick={selectAll} className="filler-modal__action-btn">
            Select All
          </button>
          <button onClick={selectNone} className="filler-modal__action-btn">
            Select None
          </button>
        </div>

        <div className="filler-modal__list">
          {filteredFillers.map(word => {
            const count = matchingCounts.get(word) || 0;
            return (
              <label key={word} className="filler-modal__item">
                <input
                  type="checkbox"
                  checked={selectedFillers.has(word)}
                  onChange={() => toggleFiller(word)}
                />
                <span className="filler-modal__word">{word}</span>
                {count > 0 && (
                  <span className="filler-modal__count">({count})</span>
                )}
              </label>
            );
          })}
          {customFillers.map(word => {
            const count = matchingCounts.get(word) || 0;
            return (
              <label key={word} className="filler-modal__item filler-modal__item--custom">
                <input
                  type="checkbox"
                  checked={selectedFillers.has(word)}
                  onChange={() => toggleFiller(word)}
                />
                <span className="filler-modal__word">{word}</span>
                {count > 0 && (
                  <span className="filler-modal__count">({count})</span>
                )}
                <button
                  className="filler-modal__remove-custom"
                  onClick={(e) => {
                    e.preventDefault();
                    setSelectedFillers(prev => {
                      const next = new Set(prev);
                      next.delete(word);
                      return next;
                    });
                  }}
                  aria-label={`Remove ${word}`}
                >
                  ×
                </button>
              </label>
            );
          })}
        </div>

        <div className="filler-modal__add-custom">
          <input
            type="text"
            placeholder="Add custom filler word..."
            value={customWord}
            onChange={(e) => setCustomWord(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddCustom();
              }
            }}
            aria-label="Add custom filler word"
          />
          <button onClick={handleAddCustom} disabled={!customWord.trim()}>
            Add
          </button>
        </div>

        <div className="filler-modal__footer">
          <span className="filler-modal__summary">
            {selectedFillers.size} words selected • {totalMatches} matches
          </span>
          <div className="filler-modal__buttons">
            <button className="filler-modal__cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              className="filler-modal__apply"
              onClick={handleApply}
              disabled={totalMatches === 0}
            >
              Mark as Deleted ({totalMatches})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface TranscriptViewerProps {
  transcript: Transcript;
  mediaRef: RefObject<HTMLAudioElement | HTMLVideoElement>;
  viewMode?: 'transcript' | 'json' | 'edited-json';
  rawData?: any;
  onHasEditsChange?: (hasEdits: boolean) => void;
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
 * Inserted (pasted) words each get their own segment since they may be duplicates.
 */
function buildPlaybackSegments(editedWords: EditableWord[]): PlaybackSegment[] {
  const activeWords = editedWords.filter(w => !w.deleted);
  if (activeWords.length === 0) return [];

  const segments: PlaybackSegment[] = [];
  let currentSegment: PlaybackSegment | null = null;
  let lastOriginalIndex = -2; // Use -2 so first word always starts new segment
  let lastWasInserted = false;

  for (let i = 0; i < editedWords.length; i++) {
    const ew = editedWords[i];
    if (ew.deleted) continue;

    // Check if this word is consecutive to the previous in the original
    // Inserted words always start a new segment (they might be duplicates)
    const isConsecutive = !ew.inserted && !lastWasInserted && ew.originalIndex === lastOriginalIndex + 1;

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
    lastWasInserted = ew.inserted ?? false;
  }

  if (currentSegment) {
    segments.push(currentSegment);
  }

  return segments;
}

/** Minimum silence duration in milliseconds to detect and insert */
const MIN_SILENCE_MS = 100;

/**
 * Detect silences between words and return a new array with silence pseudo-words inserted.
 * Silences are detected as gaps between the endMs of one word and startMs of the next.
 */
function insertSilences(words: TranscriptWord[]): TranscriptWord[] {
  if (words.length === 0) return [];
  
  const result: TranscriptWord[] = [];
  
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    
    // Check for silence before the first word (from 0ms)
    if (i === 0 && word.startMs > MIN_SILENCE_MS) {
      result.push({
        text: `[${(word.startMs / 1000).toFixed(1)}s]`,
        startMs: 0,
        endMs: word.startMs,
        wordType: 'silence',
      });
    }
    
    // Add the word (with default wordType)
    result.push({ ...word, wordType: word.wordType ?? 'word' });
    
    // Check for silence after this word (gap before next word)
    if (i < words.length - 1) {
      const nextWord = words[i + 1];
      const gapMs = nextWord.startMs - word.endMs;
      
      if (gapMs >= MIN_SILENCE_MS) {
        result.push({
          text: `[${(gapMs / 1000).toFixed(1)}s]`,
          startMs: word.endMs,
          endMs: nextWord.startMs,
          wordType: 'silence',
        });
      }
    }
  }
  
  return result;
}

/** Initialize editable words from transcript, inserting detected silences */
function initEditableWords(transcript: Transcript): EditableWord[] {
  // First insert silences between the original words
  const wordsWithSilences = insertSilences(transcript.words);
  
  return wordsWithSilences.map((word, index) => ({
    originalIndex: index,
    word,
    deleted: false,
  }));
}

export const TranscriptViewer: FC<TranscriptViewerProps> = ({
  transcript,
  mediaRef,
  viewMode = 'transcript',
  rawData,
  onHasEditsChange,
}) => {
  // Edit mode state
  const [editedWords, setEditedWords] = useState<EditableWord[]>(() => 
    initEditableWords(transcript)
  );
  const [undoStack, setUndoStack] = useState<EditableWord[][]>([]);
  const [clipboard, setClipboard] = useState<ClipboardData | null>(null);
  const [hasEdits, setHasEdits] = useState(false);
  
  // Cursor position: 'before' means cursor is before cursorIndex word,
  // 'after' means cursor is after the last word (only valid when cursorIndex is last word)
  const [cursorPosition, setCursorPosition] = useState<'before' | 'after'>('before');
  
  // Helper to save current state to undo stack before making changes
  const pushUndo = useCallback(() => {
    setUndoStack(prev => [...prev, editedWords]);
  }, [editedWords]);
  
  // Playback state
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);
  const [cursorIndex, setCursorIndex] = useState<number>(0);
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [selection, setSelection] = useState<SelectionRange | null>(null);
  const [isSeeking, setIsSeeking] = useState(false);
  const [isPlayingSequence, setIsPlayingSequence] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [showFillerModal, setShowFillerModal] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const userSetCursor = useRef<number | null>(null);
  const isDragging = useRef<boolean>(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef<boolean>(false);
  const wordPlaybackStartMs = useRef<number | null>(null);
  const wordPlaybackEndMs = useRef<number | null>(null);
  
  // Segment playback refs
  const playbackSegments = useRef<PlaybackSegment[]>([]);
  const currentSegmentIndex = useRef<number>(0);

  // Reset edited words when transcript changes
  useEffect(() => {
    setEditedWords(initEditableWords(transcript));
    setUndoStack([]);
    setHasEdits(false);
    setCursorIndex(0);
    setCursorPosition('before');
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
      setCursorPosition('before');
      setSelection(null);
      setSelectionAnchor(null);
    }
  }, [activeWordIndex, isSeeking, transcript.words]);

  // Auto-focus the transcript content for keyboard navigation
  useEffect(() => {
    if (viewMode === 'transcript' && contentRef.current) {
      contentRef.current.focus();
    }
  }, [viewMode, transcript]);

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
        debug('Playback', `Stopping at word end (${wordPlaybackEndMs.current}ms), reseeking to start`);
        media.pause();
        // Reseek to start of the word so playhead is at word beginning
        if (wordPlaybackStartMs.current !== null) {
          media.currentTime = wordPlaybackStartMs.current / 1000;
          wordPlaybackStartMs.current = null;
        }
        wordPlaybackEndMs.current = null;
      }

      // Find active word in edited list
      // During segment playback, use the current segment's indices to find the right word
      // (important for duplicate/pasted words with same timing)
      let editedIndex = -1;
      
      if (isPlayingSequence && playbackSegments.current.length > 0) {
        const currentSeg = playbackSegments.current[currentSegmentIndex.current];
        if (currentSeg) {
          // Find which word in the current segment matches the time
          for (const idx of currentSeg.editedIndices) {
            const ew = editedWords[idx];
            if (ew && !ew.deleted && timeMs >= ew.word.startMs && timeMs < ew.word.endMs) {
              editedIndex = idx;
              break;
            }
          }
        }
      }
      
      // Fallback: time-based lookup for non-segment playback
      if (editedIndex === -1) {
        editedIndex = editedWords.findIndex(
          (ew) => !ew.deleted && timeMs >= ew.word.startMs && timeMs < ew.word.endMs
        );
      }
      
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
    setCursorPosition('before');
    userSetCursor.current = index;
    
    if (e.shiftKey && selectionAnchor !== null) {
      // Extend selection with shift+click
      setSelection({
        start: Math.min(selectionAnchor, index),
        end: Math.max(selectionAnchor, index),
      });
    } else if (!isDragging.current) {
      // Only clear selection and play if not dragging
      // Clear selection and set new anchor
      setSelectionAnchor(index);
      setSelection(null);
      
      // Stop current playback, seek to word, and play just that word
      const media = mediaRef.current;
      if (media) {
        debug('Seek', `Seeking to ${word.startMs}ms ("${word.text}"), will stop at ${word.endMs}ms`);
        media.pause();
        media.currentTime = word.startMs / 1000;
        wordPlaybackStartMs.current = word.startMs;
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

  // Helper to toggle deleted state on a word
  const toggleWordDeleted = useCallback((index: number, source: string) => {
    const ew = editedWords[index];
    if (!ew) return;
    
    pushUndo();
    const newEditedWords = [...editedWords];
    newEditedWords[index] = { ...ew, deleted: !ew.deleted };
    setEditedWords(newEditedWords);
    setHasEdits(true);
    debug('Edit', `${source} toggled "${ew.word.text}" to ${ew.deleted ? 'restored' : 'deleted'}`);
  }, [editedWords, pushUndo]);

  const handleWordDoubleClick = (index: number, e: React.MouseEvent) => {
    e.preventDefault();
    // Don't trigger if long press already fired
    if (longPressTriggered.current) return;
    toggleWordDeleted(index, 'Double-click');
  };

  const handleWordMouseDown = (index: number, e: React.MouseEvent) => {
    // Only handle left mouse button
    if (e.button !== 0) return;
    
    // Start long press timer (500ms)
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      toggleWordDeleted(index, 'Long-press');
    }, 500);
    
    isDragging.current = true;
    setSelectionAnchor(index);
    setCursorIndex(index);
    setCursorPosition('before');
    setSelection(null);
    debug('Drag', `Started at "${editedWords[index]?.word.text}"`);
  };

  const handleWordMouseEnter = (index: number) => {
    // Cancel long press if dragging to another word
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    
    if (!isDragging.current || selectionAnchor === null) return;
    
    // Update selection as mouse drags over words
    setSelection({
      start: Math.min(selectionAnchor, index),
      end: Math.max(selectionAnchor, index),
    });
    setCursorIndex(index);
  };

  const handleMouseUp = () => {
    // Clear long press timer
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    
    if (isDragging.current) {
      isDragging.current = false;
      if (selection) {
        debug('Drag', `Selected words ${selection.start}-${selection.end}`);
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
      pushUndo();
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
      pushUndo();
      const startIdx = selection ? selection.start : cursorIndex;
      const endIdx = selection ? selection.end : cursorIndex;
      const cutWords = editedWords.slice(startIdx, endIdx + 1);
      setClipboard({ words: cutWords, operation: 'cut' });
      setEditedWords(prev => {
        const updated = [...prev];
        // Mark cut words as deleted
        for (let i = startIdx; i <= endIdx; i++) {
          updated[i] = { ...updated[i], deleted: true };
        }
        return updated;
      });
      setHasEdits(true);
      debug('Edit', `Cut ${cutWords.length} word(s): "${cutWords.map(w => w.word.text).join(' ')}"`);
      handled = true;
    }
    // Paste - Cmd/Ctrl+V
    else if ((e.metaKey || e.ctrlKey) && e.key === 'v' && clipboard) {
      pushUndo();
      // Insert at cursor position: if 'before', insert before cursorIndex; if 'after', insert after cursorIndex
      const insertIndex = cursorPosition === 'after' ? cursorIndex + 1 : cursorIndex;
      setEditedWords(prev => {
        const updated = [...prev];
        const wordsToInsert = clipboard.words.map(w => ({ ...w, deleted: false, inserted: true }));
        updated.splice(insertIndex, 0, ...wordsToInsert);
        return updated;
      });
      setHasEdits(true);
      debug('Edit', `Pasted ${clipboard.words.length} words at position ${insertIndex}`);
      // Move cursor to the last pasted word with cursor after it
      setCursorIndex(insertIndex + clipboard.words.length - 1);
      setCursorPosition('after');
      setSelection(null);
      setSelectionAnchor(null);
      handled = true;
    }
    // Undo last edit - Cmd/Ctrl+Z
    else if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      if (undoStack.length > 0) {
        const previousState = undoStack[undoStack.length - 1];
        setUndoStack(prev => prev.slice(0, -1));
        setEditedWords(previousState);
        // Check if we're back to original state
        const isOriginal = previousState.every((ew, i) => 
          ew.originalIndex === i && !ew.deleted
        ) && previousState.length === transcript.words.length;
        setHasEdits(!isOriginal);
        debug('Edit', `Undo (${undoStack.length - 1} remaining)`);
      }
      handled = true;
    }
    else if (e.key === 'ArrowLeft') {
      if (cursorPosition === 'after') {
        // Move from 'after' last word back to 'before' last word
        setCursorPosition('before');
        debug('Nav', `ArrowLeft: cursor 'after' → 'before' "${editedWords[cursorIndex]?.word.text}"`);
      } else {
        newIndex = Math.max(0, cursorIndex - 1);
        debug('Nav', `ArrowLeft: "${editedWords[cursorIndex]?.word.text}" → "${editedWords[newIndex]?.word.text}"`);
      }
      handled = true;
    } else if (e.key === 'ArrowRight') {
      if (cursorIndex === wordCount - 1 && cursorPosition === 'before') {
        // At last word with cursor before it - move cursor to after
        setCursorPosition('after');
        debug('Nav', `ArrowRight: cursor 'before' → 'after' "${editedWords[cursorIndex]?.word.text}"`);
      } else if (cursorPosition !== 'after') {
        newIndex = Math.min(wordCount - 1, cursorIndex + 1);
        debug('Nav', `ArrowRight: "${editedWords[cursorIndex]?.word.text}" → "${editedWords[newIndex]?.word.text}"`);
      }
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
        debug('Nav', `${e.key}: "${editedWords[cursorIndex]?.word.text}" → "${editedWords[newIndex]?.word.text}"`);
      }
      handled = true;
    } else if (e.key === 'Home') {
      newIndex = 0;
      debug('Nav', `Home: "${editedWords[cursorIndex]?.word.text}" → "${editedWords[newIndex]?.word.text}"`);
      handled = true;
    } else if (e.key === 'End') {
      newIndex = wordCount - 1;
      debug('Nav', `End: "${editedWords[cursorIndex]?.word.text}" → "${editedWords[newIndex]?.word.text}"`);
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
      if (newIndex !== cursorIndex) {
        setCursorIndex(newIndex);
        setCursorPosition('before');
      }

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
  }, [cursorIndex, cursorPosition, selectionAnchor, editedWords, mediaRef, hasEdits, clipboard, selection, transcript, pushUndo, undoStack]);

  const isWordSelected = (index: number): boolean => {
    if (!selection) return false;
    return index >= selection.start && index <= selection.end;
  };

  const getSelectedText = (): string => {
    if (!selection) return '';
    return editedWords
      .slice(selection.start, selection.end + 1)
      .filter(ew => !ew.deleted && ew.word.wordType !== 'silence')
      .map(ew => ew.word.text)
      .join(' ');
  };

  // Handle copy
  const handleCopy = useCallback((e: React.ClipboardEvent) => {
    const selectedText = getSelectedText();
    if (selectedText) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', selectedText);
      debug('Edit', `Copied text: "${selectedText.substring(0, 50)}${selectedText.length > 50 ? '...' : ''}"`);
    }
  }, [selection, editedWords]);

  // Count active (non-deleted) words (excluding silences for word count)
  const activeWordCount = editedWords.filter(ew => !ew.deleted && ew.word.wordType !== 'silence').length;
  const activeSilenceCount = editedWords.filter(ew => !ew.deleted && ew.word.wordType === 'silence').length;
  const deletedWordCount = editedWords.filter(ew => ew.deleted && ew.word.wordType !== 'silence').length;
  const deletedSilenceCount = editedWords.filter(ew => ew.deleted && ew.word.wordType === 'silence').length;

  // Calculate filler word matches for modal (exclude silences)
  const getFillerMatchCounts = useCallback((): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const ew of editedWords) {
      if (ew.deleted || ew.word.wordType === 'silence') continue;
      const wordText = ew.word.text.toLowerCase().replace(/[.,!?;:]/g, '');
      for (const filler of DEFAULT_FILLER_WORDS) {
        if (wordText === filler) {
          counts.set(filler, (counts.get(filler) || 0) + 1);
        }
      }
      // Also check for the exact word in case it's a custom filler
      counts.set(wordText, (counts.get(wordText) || 0) + 1);
    }
    return counts;
  }, [editedWords]);

  // Handle removing filler words (exclude silences from matching)
  const handleRemoveFillers = useCallback((fillerWords: string[]) => {
    const fillerSet = new Set(fillerWords.map(f => f.toLowerCase()));
    const newEditedWords = editedWords.map(ew => {
      if (ew.deleted || ew.word.wordType === 'silence') return ew;
      const wordText = ew.word.text.toLowerCase().replace(/[.,!?;:]/g, '');
      if (fillerSet.has(wordText)) {
        return { ...ew, deleted: true };
      }
      return ew;
    });
    
    const deletedCount = newEditedWords.filter((ew, i) => 
      ew.deleted && !editedWords[i].deleted
    ).length;
    
    if (deletedCount > 0) {
      pushUndo();
      setEditedWords(newEditedWords);
      setHasEdits(true);
      debug('Edit', `Removed ${deletedCount} filler words`);
    }
  }, [editedWords, pushUndo]);

  // Notify parent when hasEdits changes
  useEffect(() => {
    onHasEditsChange?.(hasEdits);
  }, [hasEdits, onHasEditsChange]);

  // JSON view of original transcript
  if (viewMode === 'json') {
    return (
      <div className="transcript-viewer">
        <div className="transcript-viewer__header">
          <h3>Original Transcript JSON</h3>
        </div>
        <div className="transcript-viewer__raw">
          <pre>{JSON.stringify(transcript, null, 2)}</pre>
        </div>
      </div>
    );
  }

  // JSON view of edited state
  if (viewMode === 'edited-json') {
    return (
      <div className="transcript-viewer">
        <div className="transcript-viewer__header">
          <h3>Edited State JSON</h3>
        </div>
        <div className="transcript-viewer__raw">
          <pre>{JSON.stringify(editedWords, null, 2)}</pre>
        </div>
      </div>
    );
  }

  // Raw provider response (for debugging)
  if (viewMode === 'transcript' && rawData === null) {
    // This is a placeholder - rawData view handled by parent
  }

  return (
    <div className="transcript-viewer">
      <div className="transcript-viewer__header">
        <h3>Transcript {hasEdits && <span className="transcript-viewer__edited-badge">Edited</span>}</h3>
        <div className="transcript-viewer__header-actions">
          <button
            className="transcript-viewer__filler-btn"
            onClick={() => setShowFillerModal(true)}
            aria-label="Remove filler words"
          >
            Remove Fillers
          </button>
          <div className="transcript-viewer__meta">
            <span>{activeWordCount} words</span>
            {activeSilenceCount > 0 && (
              <span className="transcript-viewer__silence-count">
                {activeSilenceCount} silences
              </span>
            )}
            {(deletedWordCount > 0 || deletedSilenceCount > 0) && (
              <span className="transcript-viewer__deleted-count">
                {deletedWordCount + deletedSilenceCount} deleted
              </span>
            )}
            {transcript.speakers && (
              <span>{transcript.speakers.length} speakers</span>
            )}
            <span>{Math.round(transcript.durationMs / 1000)}s</span>
          </div>
        </div>
      </div>

      <FillerWordsModal
        isOpen={showFillerModal}
        onClose={() => setShowFillerModal(false)}
        onApply={handleRemoveFillers}
        matchingCounts={getFillerMatchCounts()}
      />

      {hasEdits && (
        <div className="transcript-viewer__edit-bar">
          <span className="transcript-viewer__edit-hint">
            Double-click or long-press to toggle • Del to delete • ⌘X cut • ⌘V paste • ⌘Z undo{undoStack.length > 0 ? ` (${undoStack.length})` : ''}
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
        className={`transcript-viewer__content${isFocused ? ' transcript-viewer__content--focused' : ''}`}
        ref={contentRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onCopy={handleCopy}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        role="listbox"
        aria-label="Transcript words"
        aria-activedescendant={`word-${cursorIndex}`}
      >
        {editedWords.map((ew, index) => {
          const isActive = index === activeWordIndex;
          const isCursor = index === cursorIndex;
          const isSelected = isWordSelected(index);
          const isDeleted = ew.deleted;
          const isInserted = ew.inserted;
          const isSilence = ew.word.wordType === 'silence';
          const showCursorBefore = isCursor && cursorPosition === 'before';
          const showCursorAfter = isCursor && cursorPosition === 'after' && index === editedWords.length - 1;
          
          return (
            <span
              key={`${ew.originalIndex}-${index}`}
              id={`word-${index}`}
              data-word-index={index}
              className={`transcript-viewer__word${
                isActive ? ' transcript-viewer__word--active' : ''
              }${isCursor ? ' transcript-viewer__word--cursor' : ''
              }${isSelected ? ' transcript-viewer__word--selected' : ''
              }${isDeleted ? ' transcript-viewer__word--deleted' : ''
              }${isInserted ? ' transcript-viewer__word--inserted' : ''
              }${isSilence ? ' transcript-viewer__word--silence' : ''
              }${showCursorBefore ? ' transcript-viewer__word--cursor-before' : ''
              }${showCursorAfter ? ' transcript-viewer__word--cursor-after' : ''}`}
              onClick={(e) => handleWordClick(ew.word, index, e)}
              onDoubleClick={(e) => handleWordDoubleClick(index, e)}
              onMouseDown={(e) => handleWordMouseDown(index, e)}
              onMouseEnter={() => handleWordMouseEnter(index)}
              role="option"
              aria-selected={isSelected || isCursor}
              title={`${ew.word.startMs}ms - ${ew.word.endMs}ms${
                ew.word.confidence ? ` (${Math.round(ew.word.confidence * 100)}%)` : ''
              }${isSilence ? ` [SILENCE: ${((ew.word.endMs - ew.word.startMs) / 1000).toFixed(1)}s]` : ''
              }${isDeleted ? ' [DELETED - double-click to restore]' : ''
              }${isInserted ? ' [INSERTED]' : ''
              }${!isDeleted && !isInserted && !isSilence ? ' (double-click to delete)' : ''}`}
            >
              {ew.word.text}{' '}
            </span>
          );
        })}
      </div>
    </div>
  );
};
