import type { FC, RefObject } from 'react';
import { useEffect, useState, useCallback, useRef } from 'react';
import type { Transcript, TranscriptWord, EditableWord, PlaybackSegment, PlaybackSpeed, SpeedMarker } from '../types';
import { PLAYBACK_SPEEDS } from '../types';
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
  onApply: (fillerWords: string[], removeSilenceAbove: number | null) => void;
  matchingCounts: Map<string, number>;
  /** Duration in ms for each filler word */
  fillerDurations: Map<string, number>;
  /** Count and total duration of silences at each threshold */
  silenceCounts: { threshold: number; count: number; durationMs: number }[];
  /** Current total duration in ms */
  currentDurationMs: number;
}

/** Modal component for selecting filler words to remove */
const FillerWordsModal: FC<FillerWordsModalProps> = ({ isOpen, onClose, onApply, matchingCounts, fillerDurations, silenceCounts, currentDurationMs }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFillers, setSelectedFillers] = useState<Set<string>>(new Set(DEFAULT_FILLER_WORDS));
  const [customWord, setCustomWord] = useState('');
  const [removeSilence, setRemoveSilence] = useState(false);
  const [silenceThreshold, setSilenceThreshold] = useState(0.4); // Default 0.4s
  const modalRef = useRef<HTMLDivElement>(null);

  // Format duration in seconds or mm:ss
  const formatDuration = (ms: number): string => {
    const totalSeconds = Math.round(ms / 1000);
    if (totalSeconds < 90) {
      return `${totalSeconds}s`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };

  // Filter filler words based on search, then sort by count (matches first)
  const filteredFillers = DEFAULT_FILLER_WORDS
    .filter(word => word.toLowerCase().includes(searchTerm.toLowerCase()))
    .sort((a, b) => {
      const countA = matchingCounts.get(a) || 0;
      const countB = matchingCounts.get(b) || 0;
      // Sort by count descending, then alphabetically
      if (countB !== countA) return countB - countA;
      return a.localeCompare(b);
    });

  // Get custom words that have been added, sorted by count
  const customFillers = Array.from(selectedFillers)
    .filter(word => !DEFAULT_FILLER_WORDS.includes(word))
    .filter(word => word.toLowerCase().includes(searchTerm.toLowerCase()))
    .sort((a, b) => {
      const countA = matchingCounts.get(a) || 0;
      const countB = matchingCounts.get(b) || 0;
      if (countB !== countA) return countB - countA;
      return a.localeCompare(b);
    });

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

  // Get count and duration of silences that would be removed at current threshold
  const silenceData = removeSilence 
    ? (silenceCounts.find(s => s.threshold === silenceThreshold) || { count: 0, durationMs: 0 })
    : { count: 0, durationMs: 0 };
  const silenceRemovalCount = silenceData.count;
  const silenceDurationMs = silenceData.durationMs;

  const handleApply = () => {
    onApply(Array.from(selectedFillers), removeSilence ? silenceThreshold : null);
    onClose();
  };

  const selectAll = () => {
    setSelectedFillers(new Set([...DEFAULT_FILLER_WORDS, ...customFillers]));
  };

  const selectNone = () => {
    setSelectedFillers(new Set());
  };

  // Calculate total matches (filler words + silences)
  const fillerMatches = Array.from(selectedFillers).reduce(
    (sum, word) => sum + (matchingCounts.get(word) || 0),
    0
  );
  const totalMatches = fillerMatches + silenceRemovalCount;

  // Calculate time saved from filler words
  const fillerTimeSavedMs = Array.from(selectedFillers).reduce(
    (sum, word) => sum + (fillerDurations.get(word) || 0),
    0
  );
  
  // Total time saved (filler words + silences)
  const totalTimeSavedMs = fillerTimeSavedMs + silenceDurationMs;
  const newDurationMs = currentDurationMs - totalTimeSavedMs;

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

        <div className="filler-modal__silence-option">
          <label className="filler-modal__silence-checkbox">
            <input
              type="checkbox"
              checked={removeSilence}
              onChange={(e) => setRemoveSilence(e.target.checked)}
            />
            <span>Remove silences greater than</span>
          </label>
          <select
            className="filler-modal__silence-select"
            value={silenceThreshold}
            onChange={(e) => setSilenceThreshold(parseFloat(e.target.value))}
            disabled={!removeSilence}
            aria-label="Silence threshold in seconds"
          >
            <option value={0.3}>0.3s</option>
            <option value={0.4}>0.4s</option>
            <option value={0.5}>0.5s</option>
            <option value={0.75}>0.75s</option>
            <option value={1.0}>1.0s</option>
            <option value={1.5}>1.5s</option>
            <option value={2.0}>2.0s</option>
          </select>
          {removeSilence && silenceRemovalCount > 0 && (
            <span className="filler-modal__silence-count">({silenceRemovalCount} silences)</span>
          )}
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
            {totalMatches} items • saves {formatDuration(totalTimeSavedMs)} → {formatDuration(newDurationMs)}
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

/** Props for the word editor modal */
interface WordEditorModalProps {
  isOpen: boolean;
  editableWord: EditableWord | null;
  onClose: () => void;
  onSave: (newText: string) => void;
  onSplitSilence: (durations: number[]) => void;
  onDelete: () => void;
}

/**
 * Modal for editing a word or splitting a silence.
 * For silences, enter space-separated durations (e.g., "1 1 4 1") to split.
 */
const WordEditorModal: FC<WordEditorModalProps> = ({
  isOpen,
  editableWord,
  onClose,
  onSave,
  onSplitSilence,
  onDelete,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const isSilence = editableWord?.word.wordType === 'silence';
  const durationMs = editableWord ? editableWord.word.endMs - editableWord.word.startMs : 0;
  const durationSec = durationMs / 1000;

  // Reset input when modal opens
  useEffect(() => {
    if (isOpen && editableWord) {
      if (isSilence) {
        setInputValue('');
      } else {
        setInputValue(editableWord.word.text);
      }
      setError(null);
      // Focus input after a short delay to ensure modal is rendered
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, editableWord, isSilence]);

  // Parse silence split input (pure function, no side effects)
  const parseSilenceSplit = (input: string): { durations: number[]; remainder: number; error?: string } | null => {
    const trimmed = input.trim();
    if (!trimmed) return null;

    const parts = trimmed.split(/\s+/);
    const durations: number[] = [];
    let total = 0;

    for (const part of parts) {
      const num = parseFloat(part);
      if (isNaN(num) || num <= 0) {
        return { durations: [], remainder: 0, error: `Invalid number: "${part}"` };
      }
      durations.push(num);
      total += num;
    }

    if (total >= durationSec) {
      return { durations: [], remainder: 0, error: `Total (${total.toFixed(1)}s) exceeds silence duration (${durationSec.toFixed(1)}s)` };
    }

    const remainder = durationSec - total;
    return { durations, remainder };
  };

  const handleApply = () => {
    if (isSilence) {
      const parsed = parseSilenceSplit(inputValue);
      if (parsed?.error) {
        setError(parsed.error);
        return;
      }
      if (parsed && parsed.durations.length > 0) {
        // Add the remainder as the final segment
        const allDurations = [...parsed.durations, parsed.remainder];
        onSplitSilence(allDurations);
        onClose();
      }
    } else {
      const trimmed = inputValue.trim();
      if (trimmed && trimmed !== editableWord?.word.text) {
        onSave(trimmed);
      }
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApply();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  // Close on escape (document level)
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEsc);
      return () => document.removeEventListener('keydown', handleEsc);
    }
  }, [isOpen, onClose]);

  // Click outside to close
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

  if (!isOpen || !editableWord) return null;

  // Preview for silence splitting
  const preview = isSilence ? parseSilenceSplit(inputValue) : null;

  return (
    <div className="word-editor-overlay" role="dialog" aria-modal="true" aria-labelledby="word-editor-title">
      <div className="word-editor" ref={modalRef}>
        <div className="word-editor__header">
          <h3 id="word-editor-title">
            {isSilence ? 'Split Silence' : 'Edit Word'}
          </h3>
          <button className="word-editor__close" onClick={onClose} aria-label="Close editor">
            ×
          </button>
        </div>

        <div className="word-editor__content">
          {isSilence ? (
            <>
              <p className="word-editor__info">
                Silence duration: <strong>{durationSec.toFixed(1)}s</strong>
              </p>
              <p className="word-editor__hint">
                Enter space-separated durations to split (e.g., "1 1 4 1")
              </p>
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => {
                  setInputValue(e.target.value);
                  setError(null);
                }}
                onKeyDown={handleKeyDown}
                placeholder="1 2 3..."
                aria-label="Split durations"
                className="word-editor__input"
              />
              {error && <p className="word-editor__error">{error}</p>}
              {preview && !preview.error && preview.durations.length > 0 && !error && (
                <p className="word-editor__preview">
                  Preview: {[...preview.durations, preview.remainder].map(d => `[${d.toFixed(1)}s]`).join(' ')}
                </p>
              )}
              {preview?.error && !error && (
                <p className="word-editor__error">{preview.error}</p>
              )}
            </>
          ) : (
            <>
              <p className="word-editor__info">
                Edit the word text:
              </p>
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                aria-label="Word text"
                className="word-editor__input"
              />
            </>
          )}
        </div>

        <div className="word-editor__footer">
          <button className="word-editor__delete-btn" onClick={onDelete}>
            {editableWord.deleted ? 'Restore' : 'Delete'}
          </button>
          <div className="word-editor__actions">
            <button className="word-editor__cancel-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="word-editor__apply-btn"
              onClick={handleApply}
              disabled={isSilence 
                ? (!inputValue.trim() || !!preview?.error || !preview || preview.durations.length === 0)
                : !inputValue.trim()}
            >
              {isSilence ? 'Split' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/** Props for the silence settings modal */
interface SilenceSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  minSilenceMs: number;
  nlSilenceMs: number;
  onApply: (minSilenceMs: number, nlSilenceMs: number) => void;
}

/** Modal component for configuring silence detection settings */
const SilenceSettingsModal: FC<SilenceSettingsModalProps> = ({
  isOpen,
  onClose,
  minSilenceMs,
  nlSilenceMs,
  onApply,
}) => {
  const [threshold, setThreshold] = useState(minSilenceMs / 1000);
  const [nlThreshold, setNlThreshold] = useState(nlSilenceMs / 1000);
  const modalRef = useRef<HTMLDivElement>(null);

  // Reset when modal opens
  useEffect(() => {
    if (isOpen) {
      setThreshold(minSilenceMs / 1000);
      setNlThreshold(nlSilenceMs / 1000);
    }
  }, [isOpen, minSilenceMs, nlSilenceMs]);

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

  // Click outside to close
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

  const handleApply = () => {
    // Ensure nlThreshold is always >= threshold
    const finalNlThreshold = Math.max(nlThreshold, threshold);
    onApply(Math.round(threshold * 1000), Math.round(finalNlThreshold * 1000));
    onClose();
  };

  // Auto-adjust newline threshold if it would be less than min threshold
  const handleThresholdChange = (value: number) => {
    setThreshold(value);
    if (nlThreshold < value) {
      setNlThreshold(value);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="silence-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="silence-modal-title">
      <div className="silence-modal" ref={modalRef}>
        <div className="silence-modal__header">
          <h3 id="silence-modal-title">Silence Settings</h3>
          <button className="silence-modal__close" onClick={onClose} aria-label="Close modal">
            ×
          </button>
        </div>

        <div className="silence-modal__content">
          <label className="silence-modal__field">
            <span className="silence-modal__label">Minimum silence duration</span>
            <div className="silence-modal__input-row">
              <input
                type="range"
                min="0.1"
                max="2"
                step="0.1"
                value={threshold}
                onChange={(e) => handleThresholdChange(parseFloat(e.target.value))}
                aria-label="Minimum silence duration"
              />
              <span className="silence-modal__value">{threshold.toFixed(1)}s</span>
            </div>
            <p className="silence-modal__hint">
              Gaps shorter than this will not be shown as silences.
            </p>
          </label>

          <label className="silence-modal__field">
            <span className="silence-modal__label">Paragraph break threshold</span>
            <div className="silence-modal__input-row">
              <input
                type="range"
                min={threshold}
                max="5"
                step="0.1"
                value={nlThreshold}
                onChange={(e) => setNlThreshold(parseFloat(e.target.value))}
                aria-label="Paragraph break threshold"
              />
              <span className="silence-modal__value">{nlThreshold.toFixed(1)}s</span>
            </div>
            <p className="silence-modal__hint">
              Silences longer than this will create paragraph breaks.
            </p>
          </label>
        </div>

        <div className="silence-modal__footer">
          <button className="silence-modal__cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="silence-modal__apply" onClick={handleApply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
};

/** Props for the speed marker menu */
interface SpeedMarkerMenuProps {
  isOpen: boolean;
  position: { x: number; y: number } | null;
  wordIndex: number | null;
  currentMarker: SpeedMarker | undefined;
  defaultSpeed: PlaybackSpeed;
  onSetSpeed: (speed: PlaybackSpeed) => void;
  onRemoveMarker: () => void;
  onClose: () => void;
}

/** Popup menu for setting speed markers on a word */
const SpeedMarkerMenu: FC<SpeedMarkerMenuProps> = ({
  isOpen,
  position,
  currentMarker,
  defaultSpeed,
  onSetSpeed,
  onRemoveMarker,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on escape or click outside
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [isOpen, onClose]);

  if (!isOpen || !position) return null;

  return (
    <div
      className="speed-marker-menu"
      ref={menuRef}
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label="Set speed marker"
    >
      <div className="speed-marker-menu__header">
        Set Speed Marker
      </div>
      <div className="speed-marker-menu__options">
        {PLAYBACK_SPEEDS.map(speed => (
          <button
            key={speed}
            className={`speed-marker-menu__option${
              currentMarker?.speed === speed ? ' speed-marker-menu__option--active' : ''
            }${speed === defaultSpeed && !currentMarker ? ' speed-marker-menu__option--default' : ''}`}
            onClick={() => {
              onSetSpeed(speed);
              onClose();
            }}
            role="menuitem"
          >
            {speed}x
            {speed === defaultSpeed && !currentMarker && <span className="speed-marker-menu__default-badge">default</span>}
          </button>
        ))}
      </div>
      {currentMarker && (
        <button
          className="speed-marker-menu__remove"
          onClick={() => {
            onRemoveMarker();
            onClose();
          }}
          role="menuitem"
        >
          Remove Marker
        </button>
      )}
    </div>
  );
};

interface TranscriptViewerProps {
  transcript: Transcript;
  mediaRef: RefObject<HTMLAudioElement | HTMLVideoElement>;
  viewMode?: 'transcript' | 'data';
  dataSource?: 'editor' | 'original';
  dataFormat?: 'yaml' | 'json';
  onDataSourceChange?: (source: 'editor' | 'original') => void;
  onDataFormatChange?: (format: 'yaml' | 'json') => void;
  rawData?: any;
  onHasEditsChange?: (hasEdits: boolean) => void;
  /** Initial edited words state (from saved edits) */
  initialEditedWords?: EditableWord[];
  /** Initial undo stack (from saved edits) */
  initialUndoStack?: EditableWord[][];
  /** Callback when editor state changes (for persistence) */
  onEditorStateChange?: (editedWords: EditableWord[], undoStack: EditableWord[][]) => void;
  /** Callback when cursor position changes (reports timestamp in ms) */
  onCursorTimestampChange?: (timestampMs: number | null) => void;
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

/**
 * Get the effective playback speed at a given word index.
 * Finds the most recent speed marker at or before the word index,
 * or returns the default speed if no marker applies.
 */
function getSpeedAtIndex(
  wordIndex: number,
  speedMarkers: SpeedMarker[],
  defaultSpeed: PlaybackSpeed
): PlaybackSpeed {
  // Sort markers by word index (should already be sorted, but be safe)
  const sortedMarkers = [...speedMarkers].sort((a, b) => a.wordIndex - b.wordIndex);
  
  // Find the last marker at or before this word index
  let effectiveSpeed = defaultSpeed;
  for (const marker of sortedMarkers) {
    if (marker.wordIndex <= wordIndex) {
      effectiveSpeed = marker.speed;
    } else {
      break;
    }
  }
  return effectiveSpeed;
}

/** Default minimum silence duration in milliseconds to detect and insert */
const DEFAULT_MIN_SILENCE_MS = 400;

/** Default threshold for "newline" silences - longer pauses that indicate paragraph breaks */
const DEFAULT_NL_SILENCE_MS = 1500;

/**
 * Detect silences between words and return a new array with silence pseudo-words inserted.
 * Silences are detected as gaps between the endMs of one word and startMs of the next.
 * Silences >= nlSilenceMs are marked as 'silence-newline' for visual line breaks.
 */
function insertSilences(
  words: TranscriptWord[], 
  minSilenceMs: number = DEFAULT_MIN_SILENCE_MS,
  nlSilenceMs: number = DEFAULT_NL_SILENCE_MS
): TranscriptWord[] {
  if (words.length === 0) return [];
  
  const result: TranscriptWord[] = [];
  
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    
    // Check for silence before the first word (from 0ms)
    if (i === 0 && word.startMs > minSilenceMs) {
      const isNewline = word.startMs >= nlSilenceMs;
      result.push({
        text: `[${(word.startMs / 1000).toFixed(1)}s]`,
        startMs: 0,
        endMs: word.startMs,
        wordType: isNewline ? 'silence-newline' : 'silence',
      });
    }
    
    // Add the word (with default wordType)
    result.push({ ...word, wordType: word.wordType ?? 'word' });
    
    // Check for silence after this word (gap before next word)
    if (i < words.length - 1) {
      const nextWord = words[i + 1];
      const gapMs = nextWord.startMs - word.endMs;
      
      if (gapMs >= minSilenceMs) {
        const isNewline = gapMs >= nlSilenceMs;
        result.push({
          text: `[${(gapMs / 1000).toFixed(1)}s]`,
          startMs: word.endMs,
          endMs: nextWord.startMs,
          wordType: isNewline ? 'silence-newline' : 'silence',
        });
      }
    }
  }
  
  return result;
}

/** Initialize editable words from transcript, inserting detected silences */
function initEditableWords(
  transcript: Transcript, 
  minSilenceMs: number = DEFAULT_MIN_SILENCE_MS,
  nlSilenceMs: number = DEFAULT_NL_SILENCE_MS
): EditableWord[] {
  // First insert silences between the original words
  const wordsWithSilences = insertSilences(transcript.words, minSilenceMs, nlSilenceMs);
  
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
  dataSource = 'editor',
  dataFormat = 'yaml',
  onDataSourceChange,
  onDataFormatChange,
  rawData,
  onHasEditsChange,
  initialEditedWords,
  initialUndoStack,
  onEditorStateChange,
  onCursorTimestampChange,
}) => {
  
  // Track if we've initialized from saved state
  const initializedFromSaved = useRef(false);
  
  // Edit mode state - use initial state if provided
  const [editedWords, setEditedWords] = useState<EditableWord[]>(() => 
    initialEditedWords || initEditableWords(transcript)
  );
  const [undoStack, setUndoStack] = useState<EditableWord[][]>(initialUndoStack || []);
  const [clipboard, setClipboard] = useState<ClipboardData | null>(null);
  const [hasEdits, setHasEdits] = useState(() => {
    // Check if initial state has edits
    if (initialEditedWords) {
      return initialEditedWords.some(ew => ew.deleted || ew.inserted);
    }
    return false;
  });
  
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
  const [doubleClickAnchor, setDoubleClickAnchor] = useState<number | null>(null);
  const [isSeeking, setIsSeeking] = useState(false);
  const [isPlayingSequence, setIsPlayingSequence] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [showFillerModal, setShowFillerModal] = useState(false);
  const [showSilenceModal, setShowSilenceModal] = useState(false);
  const [minSilenceMs, setMinSilenceMs] = useState(DEFAULT_MIN_SILENCE_MS);
  const [nlSilenceMs, setNlSilenceMs] = useState(DEFAULT_NL_SILENCE_MS);
  const [editorWordIndex, setEditorWordIndex] = useState<number | null>(null);
  // Speed settings
  const [defaultSpeed, setDefaultSpeed] = useState<PlaybackSpeed>(1);
  const [speedMarkers, setSpeedMarkers] = useState<SpeedMarker[]>([]);
  const [speedMenuWordIndex, setSpeedMenuWordIndex] = useState<number | null>(null);
  const [speedMenuPosition, setSpeedMenuPosition] = useState<{ x: number; y: number } | null>(null);
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

  // Cut selection or word at cursor
  const handleCut = useCallback(() => {
    const startIdx = selection ? selection.start : cursorIndex;
    const endIdx = selection ? selection.end : cursorIndex;
    const cutWords = editedWords.slice(startIdx, endIdx + 1);
    pushUndo();
    setClipboard({ words: cutWords, operation: 'cut' });
    setEditedWords(prev => {
      const updated = [...prev];
      for (let i = startIdx; i <= endIdx; i++) {
        updated[i] = { ...updated[i], deleted: true };
      }
      return updated;
    });
    setHasEdits(true);
    debug('Edit', `Cut ${cutWords.length} word(s): "${cutWords.map(w => w.word.text).join(' ')}"`);
  }, [selection, cursorIndex, editedWords, pushUndo]);

  // Paste from clipboard at cursor position
  const handlePaste = useCallback(() => {
    if (!clipboard) return;
    pushUndo();
    const insertIndex = cursorPosition === 'after' ? cursorIndex + 1 : cursorIndex;
    setEditedWords(prev => {
      const updated = [...prev];
      const wordsToInsert = clipboard.words.map(w => ({ ...w, deleted: false, inserted: true }));
      updated.splice(insertIndex, 0, ...wordsToInsert);
      return updated;
    });
    setHasEdits(true);
    debug('Edit', `Pasted ${clipboard.words.length} word(s) at position ${insertIndex}`);
    setCursorIndex(insertIndex + clipboard.words.length - 1);
    setCursorPosition('after');
    setSelection(null);
    setSelectionAnchor(null);
  }, [clipboard, cursorPosition, cursorIndex, pushUndo]);

  // Undo last edit
  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const previousState = undoStack[undoStack.length - 1];
    setUndoStack(prev => prev.slice(0, -1));
    setEditedWords(previousState);
    const isOriginal = previousState.every((ew, i) => 
      ew.originalIndex === i && !ew.deleted
    ) && previousState.length === transcript.words.length;
    setHasEdits(!isOriginal);
    debug('Edit', `Undo (${undoStack.length - 1} remaining)`);
  }, [undoStack, transcript.words.length]);

  // Track previous transcript to detect changes
  const prevTranscriptRef = useRef(transcript);

  // Reset edited words when transcript changes (but not on initial load with saved edits)
  useEffect(() => {
    // Skip if this is the initial render with saved edits
    if (prevTranscriptRef.current === transcript) {
      return;
    }
    prevTranscriptRef.current = transcript;
    
    // Transcript changed - reset to fresh state (use current silence thresholds)
    setEditedWords(initEditableWords(transcript, minSilenceMs, nlSilenceMs));
    setUndoStack([]);
    setHasEdits(false);
    setCursorIndex(0);
    setCursorPosition('before');
    setSelection(null);
    setSelectionAnchor(null);
    initializedFromSaved.current = false;
  }, [transcript, minSilenceMs, nlSilenceMs]);

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

  // Apply default speed when it changes (and no markers override it)
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    
    // Set initial playback rate based on current position
    const timeMs = media.currentTime * 1000;
    const currentWordIndex = editedWords.findIndex(
      (ew) => !ew.deleted && timeMs >= ew.word.startMs && timeMs < ew.word.endMs
    );
    const targetSpeed = currentWordIndex >= 0 
      ? getSpeedAtIndex(currentWordIndex, speedMarkers, defaultSpeed)
      : defaultSpeed;
    
    if (media.playbackRate !== targetSpeed) {
      debug('Speed', `Setting playback rate to ${targetSpeed}x (default: ${defaultSpeed}x)`);
      media.playbackRate = targetSpeed;
    }
  }, [defaultSpeed, speedMarkers, mediaRef, editedWords]);

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
      } else if (hasEdits && !media.paused) {
        // During normal playback with edits, skip over deleted words
        // Check if we're currently in a deleted word's time range
        const inDeletedWord = editedWords.some(
          (ew) => ew.deleted && timeMs >= ew.word.startMs && timeMs < ew.word.endMs
        );
        
        if (inDeletedWord) {
          // Find the next non-deleted word after current time
          const nextNonDeleted = editedWords.find(
            (ew) => !ew.deleted && ew.word.startMs >= timeMs
          );
          
          if (nextNonDeleted) {
            debug('Skip', `Skipping deleted content, jumping to "${nextNonDeleted.word.text}" at ${nextNonDeleted.word.startMs}ms`);
            media.currentTime = nextNonDeleted.word.startMs / 1000;
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
        
        // Update playback rate based on speed markers when word changes
        if (editedIndex >= 0) {
          const targetSpeed = getSpeedAtIndex(editedIndex, speedMarkers, defaultSpeed);
          if (media.playbackRate !== targetSpeed) {
            debug('Speed', `Changing playback rate to ${targetSpeed}x at word index ${editedIndex}`);
            media.playbackRate = targetSpeed;
          }
        }
      }
      setActiveWordIndex(editedIndex >= 0 ? editedIndex : null);
    };

    media.addEventListener('timeupdate', handleTimeUpdate);
    return () => media.removeEventListener('timeupdate', handleTimeUpdate);
  }, [editedWords, mediaRef, isPlayingSequence, hasEdits, speedMarkers, defaultSpeed]);

  // Report cursor timestamp changes to parent
  useEffect(() => {
    if (onCursorTimestampChange) {
      const word = editedWords[cursorIndex];
      if (word && !word.deleted) {
        onCursorTimestampChange(word.word.startMs);
      } else {
        onCursorTimestampChange(null);
      }
    }
  }, [cursorIndex, editedWords, onCursorTimestampChange]);

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
    } else if (doubleClickAnchor !== null && doubleClickAnchor !== index && !isDragging.current) {
      // If we have a double-click anchor AND clicking a different word, select range
      const start = Math.min(doubleClickAnchor, index);
      const end = Math.max(doubleClickAnchor, index);
      setSelection({ start, end });
      setSelectionAnchor(doubleClickAnchor);
      setDoubleClickAnchor(null); // Clear the anchor after selection
      debug('Selection', `Selected range ${start}-${end} from double-click anchor`);
    } else if (doubleClickAnchor === index) {
      // Clicking on the anchor itself - do nothing, wait for potential double-click
      debug('Click', `Clicked on anchor word, waiting for double-click`);
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

  // Open word editor modal
  const openWordEditor = useCallback((index: number) => {
    setEditorWordIndex(index);
    debug('Editor', `Opened editor for "${editedWords[index]?.word.text}"`);
  }, [editedWords]);

  // Handle saving word text change
  const handleEditorSave = useCallback((newText: string) => {
    if (editorWordIndex === null) return;
    const ew = editedWords[editorWordIndex];
    if (!ew || newText === ew.word.text) return;
    
    pushUndo();
    const newEditedWords = [...editedWords];
    newEditedWords[editorWordIndex] = {
      ...ew,
      word: { ...ew.word, text: newText },
    };
    setEditedWords(newEditedWords);
    setHasEdits(true);
    debug('Editor', `Changed text from "${ew.word.text}" to "${newText}"`);
  }, [editorWordIndex, editedWords, pushUndo]);

  // Handle splitting a silence into multiple segments
  const handleSplitSilence = useCallback((durations: number[]) => {
    if (editorWordIndex === null) return;
    const ew = editedWords[editorWordIndex];
    if (!ew || ew.word.wordType !== 'silence') return;
    
    pushUndo();
    
    // Create new silence segments from the durations
    const silenceStart = ew.word.startMs;
    const newSilences: EditableWord[] = [];
    let currentMs = silenceStart;
    
    for (let i = 0; i < durations.length; i++) {
      const durationMs = Math.round(durations[i] * 1000);
      const endMs = currentMs + durationMs;
      
      newSilences.push({
        originalIndex: -1, // Negative indicates a split/inserted silence
        word: {
          text: `[${durations[i].toFixed(1)}s]`,
          startMs: currentMs,
          endMs: endMs,
          wordType: 'silence',
        },
        deleted: false,
        inserted: true,
      });
      
      currentMs = endMs;
    }
    
    // Replace the original silence with the new segments
    const newEditedWords = [...editedWords];
    newEditedWords.splice(editorWordIndex, 1, ...newSilences);
    setEditedWords(newEditedWords);
    setHasEdits(true);
    
    debug('Editor', `Split silence into ${durations.length} segments: ${durations.map(d => d.toFixed(1) + 's').join(', ')}`);
  }, [editorWordIndex, editedWords, pushUndo]);

  // Handle delete from editor
  const handleEditorDelete = useCallback(() => {
    if (editorWordIndex !== null) {
      toggleWordDeleted(editorWordIndex, 'Editor');
      setEditorWordIndex(null);
      // Restore focus to transcript content after modal closes
      setTimeout(() => contentRef.current?.focus(), 0);
    }
  }, [editorWordIndex, toggleWordDeleted]);

  // Get the speed marker at a specific word index (if any)
  const getSpeedMarkerAtIndex = useCallback((wordIndex: number): SpeedMarker | undefined => {
    return speedMarkers.find(m => m.wordIndex === wordIndex);
  }, [speedMarkers]);

  // Toggle a speed marker at a word index
  const toggleSpeedMarker = useCallback((wordIndex: number, speed: PlaybackSpeed) => {
    setSpeedMarkers(prev => {
      const existingIdx = prev.findIndex(m => m.wordIndex === wordIndex);
      if (existingIdx >= 0) {
        // If marker exists with same speed, remove it
        if (prev[existingIdx].speed === speed) {
          debug('Speed', `Removed speed marker at index ${wordIndex}`);
          return prev.filter((_, i) => i !== existingIdx);
        }
        // If marker exists with different speed, update it
        debug('Speed', `Updated speed marker at index ${wordIndex} to ${speed}x`);
        const updated = [...prev];
        updated[existingIdx] = { wordIndex, speed };
        return updated;
      }
      // Add new marker
      debug('Speed', `Added speed marker ${speed}x at index ${wordIndex}`);
      return [...prev, { wordIndex, speed }].sort((a, b) => a.wordIndex - b.wordIndex);
    });
    setHasEdits(true);
  }, []);

  // Remove a speed marker at a word index
  const removeSpeedMarker = useCallback((wordIndex: number) => {
    setSpeedMarkers(prev => {
      const filtered = prev.filter(m => m.wordIndex !== wordIndex);
      if (filtered.length !== prev.length) {
        debug('Speed', `Removed speed marker at index ${wordIndex}`);
        setHasEdits(true);
      }
      return filtered;
    });
  }, []);

  const handleWordDoubleClick = (index: number, e: React.MouseEvent) => {
    e.preventDefault();
    // Don't trigger if long press already fired
    if (longPressTriggered.current) return;
    
    // If clicking on the current anchor, clear it
    if (doubleClickAnchor === index) {
      setDoubleClickAnchor(null);
      debug('Anchor', `Cleared anchor at index ${index}`);
    } else {
      // Set new anchor (or reset if one already exists)
      setDoubleClickAnchor(index);
      setSelection(null); // Clear any existing selection
      debug('Anchor', `Set anchor at index ${index} ("${editedWords[index]?.word.text}")`);
    }
  };

  const handleWordMouseDown = (index: number, e: React.MouseEvent) => {
    // Only handle left mouse button
    if (e.button !== 0) return;
    
    // Start long press timer (500ms) - opens editor instead of toggle
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      openWordEditor(index);
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
    // When a selection exists, the anchor word's current state determines the action for all words
    if (e.key === 'Delete' || e.key === 'Backspace') {
      pushUndo();
      setEditedWords(prev => {
        const updated = [...prev];
        if (selection) {
          // Use the anchor word's state to determine action for all selected words
          // If anchor is not deleted, delete all; if anchor is deleted, restore all
          const anchorIndex = selectionAnchor ?? selection.start;
          const targetDeletedState = !prev[anchorIndex].deleted;
          for (let i = selection.start; i <= selection.end; i++) {
            updated[i] = { ...updated[i], deleted: targetDeletedState };
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
      handleCut();
      handled = true;
    }
    // Paste - Cmd/Ctrl+V
    else if ((e.metaKey || e.ctrlKey) && e.key === 'v' && clipboard) {
      handlePaste();
      handled = true;
    }
    // Undo last edit - Cmd/Ctrl+Z
    else if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      handleUndo();
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
    } else if (e.key === 'Enter') {
      // Open word editor for current word
      openWordEditor(cursorIndex);
      handled = true;
    } else if (e.key === ' ') {
      // Toggle play/pause from cursor position
      const ew = editedWords[cursorIndex];
      const media = mediaRef.current;
      if (media && ew && !ew.deleted) {
        if (media.paused) {
          // If edited, play the edited sequence; otherwise play from cursor word
          if (hasEdits) {
            // Build segments and start sequence playback
            const segments = buildPlaybackSegments(editedWords);
            debug('Segment', `Built ${segments.length} segments, cursor at index ${cursorIndex}`);
            if (segments.length > 0) {
              // Find which segment contains the cursor
              let startSegmentIdx = 0;
              let foundCursor = false;
              for (let i = 0; i < segments.length; i++) {
                if (segments[i].editedIndices.includes(cursorIndex)) {
                  startSegmentIdx = i;
                  foundCursor = true;
                  break;
                }
              }
              if (!foundCursor) {
                debug('Segment', `Cursor ${cursorIndex} not found in any segment, defaulting to 0`);
              }
              playbackSegments.current = segments;
              currentSegmentIndex.current = startSegmentIdx;
              setIsPlayingSequence(true);
              // Start from the cursor word's time, not the segment's start
              const startTimeMs = ew.word.startMs;
              debug('Segment', `Starting sequence playback from segment ${startSegmentIdx} at cursor "${ew.word.text}" (${startTimeMs}ms)`);
              media.currentTime = startTimeMs / 1000;
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
  }, [cursorIndex, cursorPosition, selectionAnchor, editedWords, mediaRef, hasEdits, clipboard, selection, transcript, pushUndo, undoStack, handleCut, handlePaste, handleUndo]);

  const isWordSelected = (index: number): boolean => {
    if (!selection) return false;
    return index >= selection.start && index <= selection.end;
  };

  // Get the words that are selected (for copy/cut operations)
  const getSelectedWords = (): EditableWord[] => {
    if (selection) {
      return editedWords
        .slice(selection.start, selection.end + 1)
        .filter(ew => !ew.deleted);
    }
    // If no selection, get the cursor word (if it's not deleted)
    const cursorWord = editedWords[cursorIndex];
    if (cursorWord && !cursorWord.deleted) {
      return [cursorWord];
    }
    return [];
  };

  // Handle copy
  const handleCopy = useCallback((e: React.ClipboardEvent) => {
    const selectedWords = getSelectedWords();
    const selectedText = selectedWords
      .filter(ew => ew.word.wordType !== 'silence')
      .map(ew => ew.word.text)
      .join(' ');
    if (selectedWords.length > 0) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', selectedText);
      // Also set the internal clipboard so paste works
      setClipboard({ words: selectedWords, operation: 'copy' });
      debug('Edit', `Copied ${selectedWords.length} word(s): "${selectedText.substring(0, 50)}${selectedText.length > 50 ? '...' : ''}"`);
    }
  }, [selection, editedWords, cursorIndex]);

  // Count active (non-deleted) words (excluding silences for word count)
  const activeWordCount = editedWords.filter(ew => !ew.deleted && ew.word.wordType !== 'silence').length;
  const activeSilenceCount = editedWords.filter(ew => !ew.deleted && ew.word.wordType === 'silence').length;
  const deletedWordCount = editedWords.filter(ew => ew.deleted && ew.word.wordType !== 'silence').length;
  const deletedSilenceCount = editedWords.filter(ew => ew.deleted && ew.word.wordType === 'silence').length;
  
  // Calculate edited duration (sum of non-deleted words/silences, adjusted for speed markers)
  const editedDurationMs = editedWords.reduce((sum, ew, index) => {
    if (ew.deleted) return sum;
    const wordDuration = ew.word.endMs - ew.word.startMs;
    const speed = getSpeedAtIndex(index, speedMarkers, defaultSpeed);
    // Duration is divided by speed (2x speed = half the time)
    return sum + (wordDuration / speed);
  }, 0);

  // Format duration: seconds only if <90s, min:sec if <60min, hour:min:sec otherwise
  const formatDuration = (ms: number): string => {
    const totalSeconds = Math.round(ms / 1000);
    if (totalSeconds < 90) {
      return `${totalSeconds}s`;
    }
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };

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

  // Calculate filler word durations for modal (total duration per filler word type)
  const getFillerDurations = useCallback((): Map<string, number> => {
    const durations = new Map<string, number>();
    for (const ew of editedWords) {
      if (ew.deleted || ew.word.wordType === 'silence' || ew.word.wordType === 'silence-newline') continue;
      const wordText = ew.word.text.toLowerCase().replace(/[.,!?;:]/g, '');
      const wordDuration = ew.word.endMs - ew.word.startMs;
      for (const filler of DEFAULT_FILLER_WORDS) {
        if (wordText === filler) {
          durations.set(filler, (durations.get(filler) || 0) + wordDuration);
        }
      }
      // Also track duration for the exact word in case it's a custom filler
      durations.set(wordText, (durations.get(wordText) || 0) + wordDuration);
    }
    return durations;
  }, [editedWords]);

  // Calculate silence counts and durations at various thresholds for the filler modal
  const getSilenceCounts = useCallback((): { threshold: number; count: number; durationMs: number }[] => {
    const thresholds = [0.3, 0.4, 0.5, 0.75, 1.0, 1.5, 2.0];
    return thresholds.map(threshold => {
      const thresholdMs = threshold * 1000;
      let count = 0;
      let durationMs = 0;
      for (const ew of editedWords) {
        if (ew.deleted) continue;
        if (ew.word.wordType !== 'silence' && ew.word.wordType !== 'silence-newline') continue;
        const silenceDuration = ew.word.endMs - ew.word.startMs;
        if (silenceDuration > thresholdMs) {
          count++;
          durationMs += silenceDuration;
        }
      }
      return { threshold, count, durationMs };
    });
  }, [editedWords]);

  // Handle removing filler words and optionally silences above threshold
  const handleRemoveFillers = useCallback((fillerWords: string[], removeSilenceAbove: number | null) => {
    const fillerSet = new Set(fillerWords.map(f => f.toLowerCase()));
    const silenceThresholdMs = removeSilenceAbove !== null ? removeSilenceAbove * 1000 : null;
    
    const newEditedWords = editedWords.map(ew => {
      if (ew.deleted) return ew;
      
      // Check if it's a silence that should be removed
      if ((ew.word.wordType === 'silence' || ew.word.wordType === 'silence-newline') && silenceThresholdMs !== null) {
        const durationMs = ew.word.endMs - ew.word.startMs;
        if (durationMs > silenceThresholdMs) {
          return { ...ew, deleted: true };
        }
        return ew;
      }
      
      // Check if it's a filler word that should be removed
      if (ew.word.wordType !== 'silence' && ew.word.wordType !== 'silence-newline') {
        const wordText = ew.word.text.toLowerCase().replace(/[.,!?;:]/g, '');
        if (fillerSet.has(wordText)) {
          return { ...ew, deleted: true };
        }
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

  // Handle applying new silence thresholds
  const handleSilenceThresholdChange = useCallback((newMinSilenceMs: number, newNlSilenceMs: number) => {
    setMinSilenceMs(newMinSilenceMs);
    setNlSilenceMs(newNlSilenceMs);
    // Rebuild the editable words with new silence detection
    // Preserve deleted status for actual words (not silences)
    const wordDeletedStatus = new Map<number, boolean>();
    editedWords.forEach(ew => {
      if (ew.word.wordType !== 'silence' && ew.word.wordType !== 'silence-newline' && ew.originalIndex >= 0) {
        // Map original word index to deleted status
        wordDeletedStatus.set(ew.originalIndex, ew.deleted);
      }
    });
    
    // Re-initialize with new thresholds
    const newEditedWords = initEditableWords(transcript, newMinSilenceMs, newNlSilenceMs);
    
    // Restore deleted status for words
    let wordIdx = 0;
    const restoredWords = newEditedWords.map(ew => {
      if (ew.word.wordType !== 'silence' && ew.word.wordType !== 'silence-newline') {
        const wasDeleted = wordDeletedStatus.get(wordIdx) ?? false;
        wordIdx++;
        return { ...ew, deleted: wasDeleted };
      }
      return ew;
    });
    
    setEditedWords(restoredWords);
    debug('Silence', `Changed thresholds: min=${newMinSilenceMs}ms, newline=${newNlSilenceMs}ms`);
  }, [editedWords, transcript]);

  // Notify parent when hasEdits changes
  useEffect(() => {
    onHasEditsChange?.(hasEdits);
  }, [hasEdits, onHasEditsChange]);

  // Notify parent when editor state changes (for persistence)
  useEffect(() => {
    // Skip the initial render if we initialized from saved state
    if (!initializedFromSaved.current && initialEditedWords) {
      initializedFromSaved.current = true;
      return;
    }
    initializedFromSaved.current = true;
    
    // Only notify if there are edits to persist
    if (hasEdits || undoStack.length > 0) {
      onEditorStateChange?.(editedWords, undoStack);
    }
  }, [editedWords, undoStack, hasEdits, onEditorStateChange, initialEditedWords]);

  // Helper to format data as JSON or YAML
  const formatData = (data: unknown, format: 'yaml' | 'json'): string => {
    if (format === 'json') {
      return JSON.stringify(data, null, 2);
    }
    // Simple YAML-like formatting (converts JSON to readable YAML format)
    const toYaml = (obj: unknown, indent = 0): string => {
      const spaces = '  '.repeat(indent);
      if (obj === null || obj === undefined) return 'null';
      if (typeof obj === 'boolean' || typeof obj === 'number') return String(obj);
      if (typeof obj === 'string') {
        // Quote strings that contain special characters
        if (obj.includes('\n') || obj.includes(':') || obj.includes('#') || 
            obj.startsWith(' ') || obj.endsWith(' ') || obj === '') {
          return JSON.stringify(obj);
        }
        return obj;
      }
      if (Array.isArray(obj)) {
        if (obj.length === 0) return '[]';
        return obj.map(item => {
          const itemStr = toYaml(item, indent + 1);
          if (typeof item === 'object' && item !== null) {
            return `\n${spaces}- ${itemStr.trim().replace(/^\n/, '').replace(/\n/g, '\n' + spaces + '  ')}`;
          }
          return `\n${spaces}- ${itemStr}`;
        }).join('');
      }
      if (typeof obj === 'object') {
        const entries = Object.entries(obj as Record<string, unknown>);
        if (entries.length === 0) return '{}';
        return entries.map(([key, value]) => {
          const valueStr = toYaml(value, indent + 1);
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            return `\n${spaces}${key}:${valueStr}`;
          } else if (Array.isArray(value)) {
            return `\n${spaces}${key}:${valueStr}`;
          }
          return `\n${spaces}${key}: ${valueStr}`;
        }).join('');
      }
      return String(obj);
    };
    return toYaml(data).trim();
  };

  // Data view (replaces old JSON and Edited JSON views)
  if (viewMode === 'data') {
    const dataToShow = dataSource === 'original' ? transcript : editedWords;
    const formattedData = formatData(dataToShow, dataFormat);
    
    return (
      <div className="transcript-viewer">
        <div className="transcript-viewer__header">
          <h3>{dataSource === 'original' ? 'Original' : 'Editor'}</h3>
          <div className="transcript-viewer__header-actions">
            <div className="transcript-viewer__data-toggles">
              <button
                className={`transcript-viewer__source-btn ${dataSource === 'editor' ? 'transcript-viewer__source-btn--active' : ''}`}
                onClick={() => onDataSourceChange?.('editor')}
                aria-pressed={dataSource === 'editor'}
              >
                Editor
              </button>
              <button
                className={`transcript-viewer__source-btn ${dataSource === 'original' ? 'transcript-viewer__source-btn--active' : ''}`}
                onClick={() => onDataSourceChange?.('original')}
                aria-pressed={dataSource === 'original'}
              >
                Original
              </button>
            </div>
            <label className="transcript-viewer__format-toggle">
              <input
                type="checkbox"
                checked={dataFormat === 'json'}
                onChange={(e) => onDataFormatChange?.(e.target.checked ? 'json' : 'yaml')}
              />
              <span>JSON</span>
            </label>
          </div>
        </div>
        <div className="transcript-viewer__raw">
          <pre>{formattedData}</pre>
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
        <h3>{hasEdits && <span className="transcript-viewer__edited-badge">Edited</span>}</h3>
        <div className="transcript-viewer__header-actions">
          <div className="transcript-viewer__speed-controls">
            <label className="transcript-viewer__speed-label" htmlFor="default-speed">
              Speed:
            </label>
            <select
              id="default-speed"
              className="transcript-viewer__speed-select"
              value={defaultSpeed}
              onChange={(e) => setDefaultSpeed(parseFloat(e.target.value) as PlaybackSpeed)}
              aria-label="Default playback speed"
            >
              {PLAYBACK_SPEEDS.map(speed => (
                <option key={speed} value={speed}>
                  {speed}x
                </option>
              ))}
            </select>
            {speedMarkers.length > 0 && (
              <span 
                className="transcript-viewer__speed-markers-count"
                title={`${speedMarkers.length} speed marker(s) set. Right-click on a word to add/remove speed markers.`}
              >
                {speedMarkers.length} marker{speedMarkers.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <button
            className="transcript-viewer__filler-btn"
            onClick={() => setShowFillerModal(true)}
            aria-label="Remove filler words"
            title="Remove filler words"
          >
            ✂️
          </button>
          <div className="transcript-viewer__meta">
            <span>{activeWordCount} words</span>
            {activeSilenceCount > 0 && (
              <button
                className="transcript-viewer__silence-count"
                onClick={() => setShowSilenceModal(true)}
                title={`Click to configure silence detection (currently ≥${(minSilenceMs / 1000).toFixed(1)}s)`}
              >
                {activeSilenceCount} silences
              </button>
            )}
            {activeSilenceCount === 0 && (
              <button
                className="transcript-viewer__silence-count transcript-viewer__silence-count--empty"
                onClick={() => setShowSilenceModal(true)}
                title={`No silences detected (threshold: ${(minSilenceMs / 1000).toFixed(1)}s). Click to configure.`}
              >
                0 silences
              </button>
            )}
            {(deletedWordCount > 0 || deletedSilenceCount > 0) && (
              <span className="transcript-viewer__deleted-count">
                {deletedWordCount + deletedSilenceCount} deleted
              </span>
            )}
            {transcript.speakers && (
              <span>{transcript.speakers.length} speakers</span>
            )}
            <span>{formatDuration(editedDurationMs)}</span>
          </div>
        </div>
      </div>

      <FillerWordsModal
        isOpen={showFillerModal}
        onClose={() => setShowFillerModal(false)}
        onApply={handleRemoveFillers}
        matchingCounts={getFillerMatchCounts()}
        fillerDurations={getFillerDurations()}
        silenceCounts={getSilenceCounts()}
        currentDurationMs={editedDurationMs}
      />

      <SilenceSettingsModal
        isOpen={showSilenceModal}
        onClose={() => setShowSilenceModal(false)}
        minSilenceMs={minSilenceMs}
        nlSilenceMs={nlSilenceMs}
        onApply={handleSilenceThresholdChange}
      />

      <WordEditorModal
        isOpen={editorWordIndex !== null}
        editableWord={editorWordIndex !== null ? editedWords[editorWordIndex] : null}
        onClose={() => {
          setEditorWordIndex(null);
          // Restore focus to transcript content after modal closes
          setTimeout(() => contentRef.current?.focus(), 0);
        }}
        onSave={handleEditorSave}
        onSplitSilence={handleSplitSilence}
        onDelete={handleEditorDelete}
      />

      <SpeedMarkerMenu
        isOpen={speedMenuWordIndex !== null}
        position={speedMenuPosition}
        wordIndex={speedMenuWordIndex}
        currentMarker={speedMenuWordIndex !== null ? getSpeedMarkerAtIndex(speedMenuWordIndex) : undefined}
        defaultSpeed={defaultSpeed}
        onSetSpeed={(speed) => {
          if (speedMenuWordIndex !== null) {
            toggleSpeedMarker(speedMenuWordIndex, speed);
          }
        }}
        onRemoveMarker={() => {
          if (speedMenuWordIndex !== null) {
            removeSpeedMarker(speedMenuWordIndex);
          }
        }}
        onClose={() => {
          setSpeedMenuWordIndex(null);
          setSpeedMenuPosition(null);
        }}
      />

      {(hasEdits || doubleClickAnchor !== null || selection !== null) && (
        <div className="transcript-viewer__edit-bar">
          <div className="transcript-viewer__edit-buttons">
            <button
              className="transcript-viewer__edit-btn"
              onClick={() => cursorIndex !== null && openWordEditor(cursorIndex)}
              title="Edit selected word (Enter)"
            >
              Edit <span className="transcript-viewer__shortcut">↵</span>
            </button>
            <button
              className="transcript-viewer__edit-btn"
              onClick={() => cursorIndex !== null && toggleWordDeleted(cursorIndex, 'button')}
              title="Delete selected word (Del)"
            >
              Del <span className="transcript-viewer__shortcut">⌫</span>
            </button>
            <button
              className="transcript-viewer__edit-btn"
              onClick={() => {
                if (selection) {
                  handleCut();
                } else if (cursorIndex !== null) {
                  // Cut single word at cursor
                  setSelection({ start: cursorIndex, end: cursorIndex });
                  setTimeout(() => handleCut(), 0);
                }
              }}
              title="Cut selection (⌘X)"
            >
              Cut <span className="transcript-viewer__shortcut">⌘X</span>
            </button>
            <button
              className="transcript-viewer__edit-btn"
              onClick={handlePaste}
              disabled={!clipboard}
              title="Paste (⌘V)"
            >
              Paste <span className="transcript-viewer__shortcut">⌘V</span>
            </button>
            <button
              className="transcript-viewer__edit-btn"
              onClick={handleUndo}
              disabled={undoStack.length === 0}
              title="Undo (⌘Z)"
            >
              Undo{undoStack.length > 0 ? ` (${undoStack.length})` : ''} <span className="transcript-viewer__shortcut">⌘Z</span>
            </button>
          </div>
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
          const isSilence = ew.word.wordType === 'silence' || ew.word.wordType === 'silence-newline';
          const isSilenceNewline = ew.word.wordType === 'silence-newline';
          const isAnchor = index === doubleClickAnchor;
          const showCursorBefore = isCursor && cursorPosition === 'before';
          const showCursorAfter = isCursor && cursorPosition === 'after' && index === editedWords.length - 1;
          const speedMarker = getSpeedMarkerAtIndex(index);
          const hasSpeedMarker = !!speedMarker;
          
          // Calculate displayed text - for silences, adjust duration based on effective speed
          const effectiveSpeed = getSpeedAtIndex(index, speedMarkers, defaultSpeed);
          let displayText = ew.word.text;
          if (isSilence && effectiveSpeed !== 1) {
            const originalDurationMs = ew.word.endMs - ew.word.startMs;
            const adjustedDurationSec = (originalDurationMs / effectiveSpeed) / 1000;
            displayText = `[${adjustedDurationSec.toFixed(1)}s]`;
          }
          
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
              }${isSilenceNewline ? ' transcript-viewer__word--silence-newline' : ''
              }${isAnchor ? ' transcript-viewer__word--anchor' : ''
              }${showCursorBefore ? ' transcript-viewer__word--cursor-before' : ''
              }${showCursorAfter ? ' transcript-viewer__word--cursor-after' : ''
              }${hasSpeedMarker ? ' transcript-viewer__word--speed-marker' : ''}`}
              onClick={(e) => handleWordClick(ew.word, index, e)}
              onDoubleClick={(e) => handleWordDoubleClick(index, e)}
              onMouseDown={(e) => handleWordMouseDown(index, e)}
              onMouseEnter={() => handleWordMouseEnter(index)}
              onContextMenu={(e) => {
                e.preventDefault();
                // Show speed marker popup - position near the word but within viewport
                const rect = e.currentTarget.getBoundingClientRect();
                const menuHeight = 280; // Approximate height of the speed menu
                const menuWidth = 150;  // Approximate width of the speed menu
                
                // Calculate position, clamping to viewport
                let x = rect.left;
                let y = rect.bottom + 4;
                
                // Ensure menu doesn't go off right edge
                if (x + menuWidth > window.innerWidth) {
                  x = window.innerWidth - menuWidth - 8;
                }
                
                // Ensure menu doesn't go off bottom edge - show above if needed
                if (y + menuHeight > window.innerHeight) {
                  y = rect.top - menuHeight - 4;
                  // If still off screen (top), just clamp to top
                  if (y < 0) {
                    y = 8;
                  }
                }
                
                setSpeedMenuPosition({ x, y });
                setSpeedMenuWordIndex(index);
              }}
              role="option"
              aria-selected={isSelected || isCursor}
              title={`${ew.word.startMs}ms - ${ew.word.endMs}ms${
                ew.word.confidence ? ` (${Math.round(ew.word.confidence * 100)}%)` : ''
              }${isSilence ? ` [SILENCE: ${((ew.word.endMs - ew.word.startMs) / 1000).toFixed(1)}s${effectiveSpeed !== 1 ? ` → ${((ew.word.endMs - ew.word.startMs) / effectiveSpeed / 1000).toFixed(1)}s @ ${effectiveSpeed}x` : ''}]` : ''
              }${isDeleted ? ' [DELETED]' : ''
              }${isInserted ? ' [INSERTED]' : ''
              }${hasSpeedMarker ? ` [SPEED: ${speedMarker.speed}x]` : ''
              }${isAnchor ? ' [ANCHOR - click another word to select range, double-click to clear]' : ''
              }${!isAnchor && !isDeleted ? ' (right-click to set speed marker)' : ''}`}
            >
              {hasSpeedMarker && (
                <span className="transcript-viewer__speed-indicator" title={`Speed: ${speedMarker.speed}x from here`}>
                  {speedMarker.speed}x
                </span>
              )}
              {displayText}{' '}
            </span>
          );
        })}
      </div>
    </div>
  );
};
