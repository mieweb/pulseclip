import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FileUpload } from './components/FileUpload';
import { PulseCamButton } from './components/PulseCamButton';
import { MediaPlayer, type MediaPlayerRef } from '@mieweb/ui/components/MediaPlayer';
import { MediaEditor } from '@mieweb/ui/components/MediaEditor';
import { ThemeToggle } from '@mieweb/ui/components/ThemeProvider';
import { Card, CardContent } from '@mieweb/ui/components/Card';
import { Button } from '@mieweb/ui/components/Button';
import { Alert } from '@mieweb/ui/components/Alert';
import { Input } from '@mieweb/ui/components/Input';
import { Select } from '@mieweb/ui/components/Select';
import { Checkbox } from '@mieweb/ui/components/Checkbox';
import { Modal, ModalHeader, ModalTitle, ModalClose, ModalBody, ModalFooter } from '@mieweb/ui/components/Modal';
import { SpinnerWithLabel } from '@mieweb/ui/components/Spinner';
// The AI-edit surface is built from the same primitives as Ozwell chat, Hey
// Ozwell and SuperChat rather than restyled to look like them — the sparkles
// mark, the bubble shell, the starter pills and the composer are all the
// library's, so this surface tracks the design system instead of drifting.
import {
  SparklesIcon,
  ChatBubble,
  SuggestedActions,
  type AISuggestedAction,
} from '@mieweb/ui/components/AI/chat';
import { MessageComposer } from '@mieweb/ui/components/Messaging';
import { RecordButton } from '@mieweb/ui/components/RecordButton';
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
} from '@mieweb/ui/components/Dropdown';
import { AudioLines, Film, Zap, Scissors, Type, Check } from 'lucide-react';
import { BrandSelector, restoreBrand } from './components/BrandSelector';
import { TranscriptDataView } from './components/TranscriptDataView';
import { UploadContractWarning } from './components/UploadContractWarning';
import type { ContractReport } from './lib/videoContract';
import { EditHistoryPanel, type CheckpointMeta } from './components/EditHistoryPanel';
import { rasterizeLowerThird } from './lib/rasterize';
import type { Provider, TranscriptionResult, FeaturedPulse, ArtipodListItem, EditableWord, SpeedMarker, PlaybackSpeed } from './types';
import { isDebugEnabled, toggleDebug } from './debug';
import { myUploadIds, rememberMyUpload } from './lib/myUploads';
import {
  loadAgentProvider,
  saveAgentProvider,
  clearAgentProvider,
  PROVIDER_PRESETS,
  type AgentProvider,
} from './lib/agentProvider';
import './App.scss';

type ViewState = 'upload' | 'loading' | 'ready' | 'transcribing' | 'viewing';

/** Saved editor state from server */
interface SavedEditorState {
  editedWords: EditableWord[];
  undoStack: EditableWord[][];
  speedMarkers?: SpeedMarker[];
  defaultSpeed?: PlaybackSpeed;
  savedAt: string;
}

/** Version info from server */
interface VersionInfo {
  commitHash: string;
  commitDate: string;
  commitUrl: string;
}

declare const __BUILD_COMMIT_HASH__: string | undefined;

/**
 * Openers for the AI-edit composer.
 *
 * An instruction is required — the agent has no default behaviour to fall back
 * on — so a blank box is a dead end for anyone who has not already decided what
 * they want. These are phrased as complete instructions rather than topics
 * because they are sent verbatim.
 */
const AGENT_STARTERS: AISuggestedAction[] = [
  {
    id: 'shorten',
    label: 'Cut to 60 seconds',
    prompt: 'Cut this down to about 60 seconds, keeping the main point intact.',
  },
  {
    id: 'tighten',
    label: 'Tighten the rambling',
    prompt: 'Cut the false starts, repeated sentences and any rambling, but keep every distinct point.',
  },
  {
    id: 'pace',
    label: 'Speed up the slow parts',
    prompt: 'Speed up the slower stretches to about 1.5x, leaving the important explanations at normal speed.',
  },
];

/**
 * What a past agent run did, drawn from its checkpoint. `durationMs` is the
 * length the server MEASURED for the result (the closed loop that checks a
 * declared target), not how long the run took.
 */
function describeAgentTurn(turn: CheckpointMeta): string {
  const parts: string[] = [];
  if (typeof turn.opCount === 'number') {
    parts.push(`${turn.opCount} ${turn.opCount === 1 ? 'edit' : 'edits'}`);
  }
  if (typeof turn.durationMs === 'number' && turn.durationMs > 0) {
    const total = Math.round(turn.durationMs / 1000);
    parts.push(`${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} long`);
  }
  return parts.join(' · ') || 'Proposed an edit';
}

/**
 * Tick for the model menu. A checkmark rather than DropdownItem's `checked`
 * checkbox: picking a model is one-of-many, and a column of checkboxes invites
 * people to tick two. The blank keeps the labels aligned.
 */
function PickedMark({ on }: { on: boolean }) {
  return on ? <Check className="h-4 w-4" aria-hidden="true" /> : <span className="block h-4 w-4" />;
}

/** Landing-page feature highlights */
const FEATURES = [
  { Icon: Zap, title: 'Transcribed Instantly', desc: 'Upload and get word-level transcripts in seconds' },
  { Icon: Scissors, title: 'Word-Level Editing', desc: 'Delete fillers and dead air with a single click' },
  { Icon: Type, title: 'Edit Like Text', desc: 'Cut and paste video as simply as a text editor' },
] as const;

/**
 * Two-row horizontal card track: scrollbar hidden, cards flow column-first
 * so the rows fill evenly; trackpad/touch scrolling moves it sideways.
 */
function PulseCarousel({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="grid grid-flow-col grid-rows-2 gap-4 pb-1">{children}</div>
    </div>
  );
}

/** Featured pulse card with graceful fallback when the thumbnail is missing or unreachable */
function FeaturedPulseCard({ pulse, onOpen }: { pulse: FeaturedPulse; onOpen: () => void }) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const showThumb = pulse.thumbnail && !thumbFailed;
  return (
    <a
      href={`/artipod/${pulse.artipodId}`}
      className="block w-56 shrink-0 no-underline"
      onClick={(e) => {
        e.preventDefault();
        onOpen();
      }}
    >
      <Card interactive padding="none" className="overflow-hidden">
        {showThumb ? (
          // Whole thumbnail always visible regardless of orientation:
          // landscape fills the 16:9 frame; portrait sits full-height and
          // centered over a blurred cover copy of itself filling the sides
          <div className="relative aspect-video overflow-hidden bg-muted">
            <img
              src={pulse.thumbnail}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-md"
            />
            <img
              src={pulse.thumbnail}
              alt=""
              className="relative h-full w-full object-contain"
              onError={() => setThumbFailed(true)}
            />
          </div>
        ) : (
          <div className="flex aspect-video items-center justify-center bg-muted">
            <Film className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
          </div>
        )}
        <CardContent className="p-3">
          <span className="text-sm font-medium text-foreground">{pulse.title}</span>
        </CardContent>
      </Card>
    </a>
  );
}

// Apply the persisted brand color theme before first paint of the app tree
restoreBrand();

function App() {
  const { artipodId: urlArtipodId } = useParams<{ artipodId: string }>();
  const navigate = useNavigate();
  
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [artipodId, setArtipodId] = useState<string>('');
  const [mediaFilename, setMediaFilename] = useState<string>('');
  const [transcribing, setTranscribing] = useState(false);
  const [transcribingAsync, setTranscribingAsync] = useState(false);
  const [transcriptionResult, setTranscriptionResult] = useState<TranscriptionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Upload-contract violations for the file the user just uploaded. Held here rather than in
   * FileUpload so the warning survives the navigation to the new artipod — the dropzone unmounts
   * the moment the upload lands.
   *
   * `artipodId` is null while the upload is still in flight and gets stamped on once the server
   * names the artipod, so the warning stops following the user around once they open another pulse.
   */
  const [uploadWarning, setUploadWarning] = useState<{
    report: ContractReport;
    artipodId: string | null;
  } | null>(null);
  const [viewMode, setViewMode] = useState<'transcript' | 'data'>('transcript');
  const [dataSource, setDataSource] = useState<'editor' | 'original'>('editor');
  const [dataFormat, setDataFormat] = useState<'yaml' | 'json'>('yaml');
  const [hasEdits, setHasEdits] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [debugMode, setDebugMode] = useState(isDebugEnabled());
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('pulseclip_api_key') || '');
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [pendingApiKey, setPendingApiKey] = useState('');
  const [featuredPulses, setFeaturedPulses] = useState<FeaturedPulse[]>([]);
  const [allPulses, setAllPulses] = useState<ArtipodListItem[]>([]);
  const [showAllPulses, setShowAllPulses] = useState(false);
  const [agentAvailable, setAgentAvailable] = useState(false);
  const [isCurrentPulseFeatured, setIsCurrentPulseFeatured] = useState(false);
  const [showFeaturedModal, setShowFeaturedModal] = useState(false);
  // Display title of the open pulse, and the rename dialog's draft value
  const [pulseTitle, setPulseTitle] = useState('');
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [featuredTitle, setFeaturedTitle] = useState('');
  const [featuredThumbnail, setFeaturedThumbnail] = useState('');
  const [splitPosition, setSplitPosition] = useState(50); // Percentage for media pane height
  const [isDragging, setIsDragging] = useState(false);
  const [savedEditorState, setSavedEditorState] = useState<SavedEditorState | null>(null);
  const [editsLoaded, setEditsLoaded] = useState(false);
  const [cursorTimestampMs, setCursorTimestampMs] = useState<number | null>(null);
  const [latestEditedWords, setLatestEditedWords] = useState<EditableWord[]>([]);
  const [exportStatus, setExportStatus] = useState<'idle' | 'exporting' | 'success' | 'error'>('idle');
  // AI editorial-agent status, and an epoch that remounts MediaEditor when the
  // agent writes a new proposal (initialEditedWords only applies on mount)
  const [agentStatus, setAgentStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [editorEpoch, setEditorEpoch] = useState(0);
  // What the agent should do, and the history of what has been done to this
  // pulse — by the agent AND by hand, on one timeline. Each entry checkpoints
  // the complete edit state, so a version can be rolled back by name rather
  // than by counting ⌘Z presses, and `historyIndex` is the undo/redo cursor.
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [agentInstructions, setAgentInstructions] = useState('');
  // A caller's own LLM account, held in this browser only. When set, agent runs
  // spend their quota instead of the shared one — and the server stops requiring
  // the app key, because the shared budget is no longer at stake.
  const [agentProvider, setAgentProvider] = useState<AgentProvider | null>(() => loadAgentProvider());
  /** The model menu under the composer. Opens itself when there is no AI at
   *  all, since otherwise nothing on screen says how to get one. */
  const [showModelMenu, setShowModelMenu] = useState(false);
  /** The inline key row, shown only after picking a provider that needs one. */
  const [showKeyForm, setShowKeyForm] = useState(false);
  /** Mirrors RecordButton's own vocabulary so the mic reports its own state. */
  const [dictationState, setDictationState] = useState<'idle' | 'recording' | 'transcribing' | 'error'>('idle');
  const [providerDraft, setProviderDraft] = useState<AgentProvider>(() => ({
    provider: 'openai',
    base: PROVIDER_PRESETS[0].base,
    model: PROVIDER_PRESETS[0].model,
    apiKey: '',
  }));
  const [providerPreset, setProviderPreset] = useState(PROVIDER_PRESETS[0].id);
  const [checkpoints, setCheckpoints] = useState<CheckpointMeta[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  /** How many word-level undo steps the editor still holds. Lets ⌘Z hand over
   *  to the version timeline only once the editor has nothing left of its own. */
  const [editorUndoDepth, setEditorUndoDepth] = useState(0);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [restoringIndex, setRestoringIndex] = useState<number | null>(null);

  const [showExportModal, setShowExportModal] = useState(false);
  const [exportName, setExportName] = useState('');
  const [exportCaptions, setExportCaptions] = useState(false);
  // MIE brand lower-third (title bar) baked into the export
  const [exportLowerThird, setExportLowerThird] = useState(false);
  const [exportTitle, setExportTitle] = useState('');
  // Refs mirror the live editor state so stable callbacks (speed saves, export)
  // always read current values without re-creating on every edit
  const latestEditedWordsRef = useRef<EditableWord[]>([]);
  const latestSpeedState = useRef<{ speedMarkers: SpeedMarker[]; defaultSpeed: PlaybackSpeed }>({
    speedMarkers: [],
    defaultSpeed: 1,
  });
  const [thumbnailStatus, setThumbnailStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement>(null);
  const playerRef = useRef<MediaPlayerRef>(null);
  /** The live media element — from MediaEditor's player when viewing, else the standalone player */
  const getMediaElement = () => playerRef.current?.mediaElement ?? mediaRef.current;
  const contentRef = useRef<HTMLElement>(null);
  /** The AI-edit modal's scrolling body, so it can open on the newest turn. */
  const agentScrollRef = useRef<HTMLDivElement>(null);
  const hasAutoTranscribed = useRef(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Held in a ref so the save callbacks handed to MediaEditor keep a stable
   *  identity — they are memoized on the artipod, not on the history list. */
  const historySyncRef = useRef<(() => void) | null>(null);
  /**
   * A new transcript rebuilds the whole edit list from scratch, and the editor
   * saves that rebuild the moment it mounts. It is not a hand edit, and its
   * words are not even comparable with the previous version's — the baseline
   * they are indexed against has changed underneath. Recording it would invent
   * a version nobody made.
   *
   * Cleared by the first real interaction with the editor rather than by the
   * first save: several save paths fire on mount (words and speed both), so a
   * flag consumed by whichever got there first would still let the other one
   * through. Nobody has edited anything until somebody touches it.
   */
  const transcriptRebuildRef = useRef(false);

  // Fetch version info on mount
  useEffect(() => {
    fetch('/api/about')
      .then((res) => res.json())
      .then((data) => {
        if (data.git) {
          setVersionInfo({
            commitHash: data.git.commitHash,
            commitDate: data.git.commitDate || '',
            commitUrl: data.git.commitUrl,
          });
        }
        setAgentAvailable(Boolean(data.agent?.configured));
      })
      .catch((err) => console.error('Failed to fetch version info:', err));
  }, []);

  // All uploads (the un-curated rest of the library). Refetched when the tab
  // regains focus so a just-finished PulseCam upload appears without a reload.
  useEffect(() => {
    const loadAllPulses = () => {
      fetch('/api/artipods')
        .then((res) => res.json())
        .then((data) => setAllPulses(data.artipods || []))
        .catch((err) => console.error('Failed to load uploads:', err));
    };
    loadAllPulses();
    window.addEventListener('focus', loadAllPulses);
    return () => window.removeEventListener('focus', loadAllPulses);
  }, []);

  // Determine current view state
  const viewState: ViewState = loading
    ? 'loading'
    : transcribing
    ? 'transcribing'
    : transcriptionResult
    ? 'viewing'
    : mediaUrl
    ? 'ready'
    : 'upload';

  // Handle split bar drag (mouse)
  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  // Handle split bar drag (touch)
  const handleSplitTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!contentRef.current) return;
      const rect = contentRef.current.getBoundingClientRect();
      const newPosition = ((e.clientY - rect.top) / rect.height) * 100;
      // Clamp between 20% and 80%
      setSplitPosition(Math.min(80, Math.max(20, newPosition)));
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault(); // Prevent page scroll on mobile
      if (!contentRef.current || e.touches.length === 0) return;
      const rect = contentRef.current.getBoundingClientRect();
      const touch = e.touches[0];
      const newPosition = ((touch.clientY - rect.top) / rect.height) * 100;
      // Clamp between 20% and 80%
      setSplitPosition(Math.min(80, Math.max(20, newPosition)));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    const handleTouchEnd = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isDragging]);

  // Add/remove split-view-active class on html element to prevent page scroll on mobile
  useEffect(() => {
    const isSplitView = viewState !== 'upload';
    if (isSplitView) {
      document.documentElement.classList.add('split-view-active');
    } else {
      document.documentElement.classList.remove('split-view-active');
    }
    return () => {
      document.documentElement.classList.remove('split-view-active');
    };
  }, [viewState]);

  // Load artipod from URL parameter on mount
  useEffect(() => {
    if (urlArtipodId && !mediaUrl) {
      setLoading(true);
      fetch(`/api/artipod/${urlArtipodId}`)
        .then((res) => {
          if (!res.ok) throw new Error('Artipod not found');
          return res.json();
        })
        .then((data) => {
          setMediaUrl(data.url);
          setArtipodId(data.artipodId);
          setMediaFilename(data.filename);
          setPulseTitle(data.title || '');
        })
        .catch((err) => {
          console.error('Failed to load artipod:', err);
          setError('Artipod not found. It may have been deleted.');
          navigate('/', { replace: true });
        })
        .finally(() => setLoading(false));
    }
  }, [urlArtipodId, mediaUrl, navigate]);

  // Load saved editor state when artipod changes
  useEffect(() => {
    if (!artipodId) {
      setSavedEditorState(null);
      setEditsLoaded(true);
      return;
    }
    
    setEditsLoaded(false);
    fetch(`/api/artipod/${artipodId}/edits`)
      .then((res) => res.json())
      .then((data) => {
        setCheckpoints(Array.isArray(data.checkpoints) ? data.checkpoints : []);
        setHistoryIndex(typeof data.historyIndex === 'number' ? data.historyIndex : -1);
        if (data.hasEdits && data.editedWords) {
          console.log(`Loaded saved edits for artipod ${artipodId}: ${data.editedWords.length} words, ${data.undoStack?.length || 0} undo states`);
          setSavedEditorState({
            editedWords: data.editedWords,
            undoStack: data.undoStack || [],
            speedMarkers: data.speedMarkers || [],
            defaultSpeed: data.defaultSpeed ?? 1,
            savedAt: data.savedAt,
          });
        } else {
          setSavedEditorState(null);
        }
      })
      .catch((err) => {
        console.error('Failed to load saved edits:', err);
        setSavedEditorState(null);
      })
      .finally(() => setEditsLoaded(true));
  }, [artipodId]);

  // Save editor state (debounced). Editing is an open participation route on
  // the server, so a missing key must not silently stop edits being saved —
  // it did, which also meant hand edits were never versioned on an unlocked
  // instance. The header is sent when there is one and omitted when there is not.
  const saveEditorState = useCallback((editedWords: EditableWord[], undoStack: EditableWord[][]) => {
    setEditorUndoDepth(undoStack.length);
    if (!artipodId) return;
    
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    
    // Debounce saves by 1 second
    saveTimeoutRef.current = setTimeout(() => {
      fetch(`/api/artipod/${artipodId}/edits`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        },
        body: JSON.stringify({
          editedWords,
          undoStack,
          recordHistory: !transcriptRebuildRef.current,
          savedAt: new Date().toISOString(),
        }),
      })
        .then((res) => {
          if (!res.ok) {
            console.error('Failed to save edits:', res.status);
            return;
          }
          // The server coalesces a burst of hand edits into one version and
          // tells us where the cursor landed. Pull the list when it moves so
          // the panel keeps up without remounting the editor.
          return res.json().then((data) => {
            if (typeof data?.historyIndex === 'number') {
              setHistoryIndex((prev) => (prev === data.historyIndex ? prev : data.historyIndex));
              historySyncRef.current?.();
            }
          });
        })
        .catch((err) => {
          console.error('Failed to save edits:', err);
        });
    }, 1000);
  }, [artipodId, apiKey]);

  // Cleanup save timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const handleEditedWordsRender = useCallback((words: EditableWord[]) => {
    latestEditedWordsRef.current = words;
    setLatestEditedWords(words);
  }, []);

  // Persist speed changes (debounced). No undoStack in the body: the server
  // keeps saved fields that are not sent, so this cannot clobber undo history.
  const handleSpeedStateChange = useCallback((speedMarkers: SpeedMarker[], defaultSpeed: PlaybackSpeed) => {
    latestSpeedState.current = { speedMarkers, defaultSpeed };
    if (!artipodId || latestEditedWordsRef.current.length === 0) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      fetch(`/api/artipod/${artipodId}/edits`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        },
        body: JSON.stringify({
          editedWords: latestEditedWordsRef.current,
          speedMarkers,
          defaultSpeed,
          recordHistory: !transcriptRebuildRef.current,
          savedAt: new Date().toISOString(),
        }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          // Re-timing a passage is an edit like any other, so it lands on the
          // same timeline and moves the same cursor.
          if (typeof data?.historyIndex === 'number') {
            setHistoryIndex((prev) => (prev === data.historyIndex ? prev : data.historyIndex));
            historySyncRef.current?.();
          }
        })
        .catch((err) => {
          console.error('Failed to save speed state:', err);
        });
    }, 1000);
  }, [artipodId, apiKey]);

  // Load available providers on mount
  useEffect(() => {
    fetch('/api/providers')
      .then((res) => res.json())
      .then((data) => {
        setProviders(data.providers);
        if (data.providers.length > 0) {
          setSelectedProvider(data.providers[0].id);
        }
      })
      .catch((err) => {
        console.error('Failed to load providers:', err);
        setError('Failed to load transcription providers');
      });
  }, []);

  // Load featured pulses on mount
  useEffect(() => {
    fetch('/api/featured')
      .then((res) => res.json())
      .then((data) => {
        setFeaturedPulses(data.featured || []);
      })
      .catch((err) => {
        console.error('Failed to load featured pulses:', err);
      });
  }, []);

  // Check if current pulse is featured
  useEffect(() => {
    if (artipodId) {
      fetch(`/api/featured/${artipodId}`)
        .then((res) => res.json())
        .then((data) => {
          setIsCurrentPulseFeatured(data.isFeatured);
        })
        .catch(() => {
          setIsCurrentPulseFeatured(false);
        });
    } else {
      setIsCurrentPulseFeatured(false);
    }
  }, [artipodId]);

  // Handle spacebar for play/pause toggle
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle spacebar when not typing in an input/textarea/select
      const media = getMediaElement();
      if (e.code === 'Space' && media) {
        const target = e.target as HTMLElement;
        const isInteractiveElement = 
          target.tagName === 'INPUT' || 
          target.tagName === 'TEXTAREA' || 
          target.tagName === 'SELECT' ||
          target.tagName === 'BUTTON' ||
          target.isContentEditable;
        
        if (!isInteractiveElement) {
          e.preventDefault();
          if (media.paused) {
            media.play();
          } else {
            media.pause();
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleFileUploaded = (url: string, newArtipodId: string, filename: string) => {
    rememberMyUpload(newArtipodId);
    // Reset auto-transcribe flag for new file
    hasAutoTranscribed.current = false;
    // Bind any playback warning to the artipod it describes.
    setUploadWarning((current) =>
      current && current.artipodId === null ? { ...current, artipodId: newArtipodId } : current
    );
    setMediaUrl(url);
    setArtipodId(newArtipodId);
    setMediaFilename(filename);
    setTranscriptionResult(null);
    setError(null);
    setMenuOpen(false);
    // Navigate to artipod-specific URL
    navigate(`/artipod/${newArtipodId}`, { replace: true });
  };

  const handleTranscribe = async (skipCache = false) => {
    if (!mediaUrl || !selectedProvider) return;

    setTranscribing(true);
    setTranscribingAsync(false);
    setTranscriptionResult(null);
    setError(null);

    try {
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };
      if (apiKey) {
        headers['X-API-Key'] = apiKey;
      }

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          mediaUrl,
          providerId: selectedProvider,
          skipCache,
          options: {
            speakerLabels: false,
          },
        }),
      });

      if (response.status === 401) {
        setShowApiKeyModal(true);
        throw new Error('API key required');
      }

      // Handle async transcription (large files)
      if (response.status === 202) {
        const asyncData = await response.json();
        const jobId = asyncData.jobId;
        setTranscribingAsync(true);
        // Poll for completion
        const pollInterval = 5000; // 5 seconds
        const maxAttempts = 360; // 30 minutes max
        let attempts = 0;
        while (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          attempts++;
          const statusRes = await fetch(`/api/transcribe/status/${jobId}`);
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            if (statusData.status === 'processing') {
              continue; // Still processing, keep polling
            }
            // Completed - statusData is the transcription result
            transcriptRebuildRef.current = true;
            setTranscriptionResult(statusData);
            return;
          } else {
            const errData = await statusRes.json().catch(() => ({}));
            throw new Error(errData.message || 'Transcription failed');
          }
        }
        throw new Error('Transcription timed out. Please try again later.');
      }

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Transcription failed');
      }

      const result: TranscriptionResult = await response.json();
      transcriptRebuildRef.current = true;
      setTranscriptionResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transcription failed');
    } finally {
      setTranscribing(false);
    }
  };

  const handleRetranscribe = () => {
    if (hasEdits) {
      if (!window.confirm('Are you sure you want to re-transcribe? All edits will be lost.')) {
        return;
      }
    }
    // Clear saved editor state when re-transcribing
    setSavedEditorState(null);
    // Also delete saved edits from server
    if (artipodId && apiKey) {
      fetch(`/api/artipod/${artipodId}/edits`, {
        method: 'DELETE',
        headers: { 'X-API-Key': apiKey },
      }).catch((err) => console.error('Failed to delete saved edits:', err));
    }
    handleTranscribe(true);
  };

  const handleNewPulse = () => {
    // Full page reload to completely clear all state
    window.location.href = '/';
  };

  // Auto-transcribe when file and provider are ready (first load only)
  useEffect(() => {
    if (
      mediaUrl &&
      selectedProvider &&
      !transcribing &&
      !transcriptionResult &&
      !loading &&
      !hasAutoTranscribed.current
    ) {
      hasAutoTranscribed.current = true;
      handleTranscribe(false);
    }
  }, [mediaUrl, selectedProvider, transcribing, transcriptionResult, loading]);

  const handleAuthError = () => {
    setShowApiKeyModal(true);
  };

  const handleToggleFeatured = async () => {
    if (!artipodId || !apiKey) {
      setShowApiKeyModal(true);
      return;
    }

    if (isCurrentPulseFeatured) {
      // Remove from featured
      try {
        const response = await fetch(`/api/featured/${artipodId}`, {
          method: 'DELETE',
          headers: {
            'X-API-Key': apiKey,
          },
        });

        if (response.status === 401) {
          setShowApiKeyModal(true);
          return;
        }

        if (response.ok) {
          setIsCurrentPulseFeatured(false);
          setFeaturedPulses((prev) => prev.filter((p) => p.artipodId !== artipodId));
        }
      } catch (err) {
        console.error('Failed to remove from featured:', err);
      }
    } else {
      // Show featured modal to set title/thumbnail
      const existingPulse = featuredPulses.find((p) => p.artipodId === artipodId);
      setFeaturedTitle(existingPulse?.title || mediaFilename);
      setFeaturedThumbnail(existingPulse?.thumbnail || '');
      setShowFeaturedModal(true);
      setMenuOpen(false);
    }
  };

  const handleFeaturedSubmit = async () => {
    if (!artipodId || !apiKey) {
      setShowApiKeyModal(true);
      return;
    }

    try {
      const response = await fetch('/api/featured', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          artipodId,
          title: featuredTitle.trim() || mediaFilename,
          thumbnail: featuredThumbnail.trim() || undefined,
        }),
      });

      if (response.status === 401) {
        setShowApiKeyModal(true);
        return;
      }

      if (response.ok) {
        const data = await response.json();
        setIsCurrentPulseFeatured(true);
        setFeaturedPulses((prev) => {
          const filtered = prev.filter((p) => p.artipodId !== artipodId);
          return [...filtered, data.pulse];
        });
        setShowFeaturedModal(false);
        setFeaturedTitle('');
        setFeaturedThumbnail('');
      }
    } catch (err) {
      console.error('Failed to save featured pulse:', err);
    }
  };

  const handleDeletePulse = async () => {
    if (!artipodId) return;
    
    if (!apiKey) {
      setShowApiKeyModal(true);
      return;
    }

    // Confirm deletion
    if (!window.confirm(`Are you sure you want to delete this pulse? This cannot be undone.`)) {
      return;
    }

    try {
      const response = await fetch(`/api/artipod/${artipodId}`, {
        method: 'DELETE',
        headers: {
          'X-API-Key': apiKey,
        },
      });

      if (response.status === 401) {
        setShowApiKeyModal(true);
        return;
      }

      if (response.ok) {
        // Remove from featured if it was there
        setFeaturedPulses((prev) => prev.filter((p) => p.artipodId !== artipodId));
        // Navigate to home
        handleNewPulse();
      } else {
        const data = await response.json();
        setError(data.message || 'Failed to delete pulse');
      }
    } catch (err) {
      console.error('Failed to delete pulse:', err);
      setError('Failed to delete pulse');
    }
  };

  const handleCaptureThumbnail = async (timestampMs: number): Promise<boolean> => {
    const media = getMediaElement();
    if (!media || !artipodId || !apiKey) {
      if (!apiKey) setShowApiKeyModal(true);
      return false;
    }

    const video = media as HTMLVideoElement;
    if (video.tagName !== 'VIDEO') {
      setError('Thumbnail capture only works with video files');
      return false;
    }

    try {
      // Seek to the specified timestamp
      const targetTime = timestampMs / 1000;
      video.currentTime = targetTime;
      
      // Wait for seek to complete
      await new Promise<void>((resolve) => {
        const handleSeeked = () => {
          video.removeEventListener('seeked', handleSeeked);
          resolve();
        };
        video.addEventListener('seeked', handleSeeked);
      });

      // Create canvas and capture frame
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setError('Failed to create canvas context');
        return false;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      
      // Convert to base64
      const imageData = canvas.toDataURL('image/png');

      // Upload thumbnail
      const uploadResponse = await fetch('/api/thumbnail', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          imageData,
          artipodId,
        }),
      });

      if (uploadResponse.status === 401) {
        setShowApiKeyModal(true);
        return false;
      }

      if (!uploadResponse.ok) {
        const data = await uploadResponse.json();
        setError(data.message || 'Failed to upload thumbnail');
        return false;
      }

      const { url } = await uploadResponse.json();

      // Update featured pulse with the thumbnail URL
      const featuredResponse = await fetch('/api/featured', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          artipodId,
          title: featuredPulses.find((p) => p.artipodId === artipodId)?.title || mediaFilename,
          thumbnail: url,
        }),
      });

      if (featuredResponse.ok) {
        const data = await featuredResponse.json();
        setFeaturedPulses((prev) => {
          const filtered = prev.filter((p) => p.artipodId !== artipodId);
          return [...filtered, data.pulse];
        });
        // Also update the featuredThumbnail state if modal is open
        setFeaturedThumbnail(url);
        return true;
      }
      return false;
    } catch (err) {
      console.error('Failed to capture thumbnail:', err);
      setError('Failed to capture thumbnail');
      return false;
    }
  };

  // Export: render the current edits server-side, then download the result
  const handleExport = async (downloadName: string) => {
    if (!artipodId || exportStatus === 'exporting') return;
    setExportStatus('exporting');
    setError(null);

    try {
      // Rasterize the MIE lower-third (an @mieweb/ui component) to a PNG the
      // server composites over the video. Non-fatal: a render hiccup just
      // exports without the title bar.
      let lowerThird: string | undefined;
      if (exportLowerThird) {
        try {
          lowerThird = await rasterizeLowerThird(exportTitle.trim() || downloadName || 'PulseClip');
        } catch (err) {
          console.error('Lower-third render failed; exporting without it:', err);
        }
      }

      const response = await fetch(`/api/artipod/${artipodId}/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        // Send live editor state; with no edits yet, let the server fall back to edits.json
        body: JSON.stringify({
          ...(latestEditedWords.length > 0 ? { editedWords: latestEditedWords } : {}),
          speedMarkers: latestSpeedState.current.speedMarkers,
          defaultSpeed: latestSpeedState.current.defaultSpeed,
          captions: exportCaptions,
          ...(lowerThird ? { lowerThird } : {}),
        }),
      });

      if (response.status === 401) {
        setExportStatus('idle');
        setShowApiKeyModal(true);
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Export failed (${response.status})`);
      }

      const { jobId } = await response.json();

      // Poll until the render completes
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const statusRes = await fetch(`/api/export/status/${jobId}`);
        const status = await statusRes.json().catch(() => ({}));

        if (statusRes.ok && status.status === 'completed') {
          // The server file is always export.mp4/.m4a; the chosen name only
          // affects what the browser saves the download as
          const ext = (status.filename || 'export.mp4').match(/\.[^.]+$/)?.[0] || '.mp4';
          const base = downloadName.replace(/\.(mp4|m4a)$/i, '').trim() || 'export';
          const link = document.createElement('a');
          link.href = status.downloadUrl;
          link.download = `${base}${ext}`;
          document.body.appendChild(link);
          link.click();
          link.remove();
          setExportStatus('success');
          setTimeout(() => setExportStatus('idle'), 3000);
          return;
        }

        if (!statusRes.ok) {
          throw new Error(status.message || status.error || 'Export failed');
        }
      }
    } catch (err) {
      console.error('Export failed:', err);
      setError(err instanceof Error ? err.message : 'Export failed');
      setExportStatus('error');
      setTimeout(() => setExportStatus('idle'), 3000);
    }
  };

  const openExportModal = () => {
    const base = mediaFilename.replace(/\.[^.]+$/, '') || 'export';
    setExportName(`${base}-edited`);
    if (!exportTitle) setExportTitle(base);
    setShowExportModal(true);
  };

  const handleExportConfirm = () => {
    setShowExportModal(false);
    handleExport(exportName);
  };

  const openAgentModal = () => {
    if (agentStatus === 'running') return;
    // With no provider at all, the useful thing to show first is how to add one.
    setShowModelMenu(!agentAvailable && !agentProvider);
    setShowAgentModal(true);
  };

  /**
   * Takes the instruction from the composer rather than from state: the
   * composer clears its (controlled) value before awaiting `onSend`, so by the
   * time this runs `agentInstructions` is already empty.
   */
  const handleAgentConfirm = (instruction: string) => {
    const text = instruction.trim();
    if (!text || !canRunAgent) return;
    setShowAgentModal(false);
    handleAgentEdit(text);
  };

  /**
   * Roll the edit state back to an earlier checkpoint. The history is not
   * truncated, so a rollback is itself reversible.
   */
  const handleRestore = async (index: number) => {
    if (!artipodId || restoringIndex !== null) return;
    setRestoringIndex(index);
    setError(null);
    try {
      const res = await fetch(`/api/artipod/${artipodId}/edits/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ index }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || 'Restore failed');
      }
      await reloadEdits();
      // The panel stays open — restoring is usually one step of comparing
      // several versions, not a thing you do once and leave.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setRestoringIndex(null);
    }
  };

  /**
   * Refresh the version list alone.
   *
   * Deliberately does NOT remount the editor: hand edits create versions as you
   * work, and remounting on each one would throw away the cursor and selection
   * of the person who is still typing.
   */
  const refreshHistory = useCallback(async () => {
    if (!artipodId) return;
    try {
      const res = await fetch(`/api/artipod/${artipodId}/edits`);
      const data = await res.json();
      setCheckpoints(Array.isArray(data.checkpoints) ? data.checkpoints : []);
      setHistoryIndex(typeof data.historyIndex === 'number' ? data.historyIndex : -1);
    } catch {
      /* the list is a convenience; a failed refresh should not disturb editing */
    }
  }, [artipodId]);

  useEffect(() => {
    historySyncRef.current = refreshHistory;
  }, [refreshHistory]);

  // Undo and redo are the cursor moving along the timeline. Restoring never
  // truncates, so stepping back and forward is symmetric; only a NEW edit made
  // while rewound abandons the versions ahead (the server does that).
  const canUndoVersion = historyIndex > 0;
  const canRedoVersion = historyIndex >= 0 && historyIndex < checkpoints.length - 1;
  const currentCheckpoint = historyIndex >= 0 ? checkpoints[historyIndex] : undefined;

  /**
   * ⌘Z / ⌘Y — undo and redo, layered over the editor's own word-level undo.
   *
   * ⌘Z steps the version timeline in two cases: when the current version is an
   * AI run (one run can delete two hundred words, and undoing it a word at a
   * time is not undoing it), and when the editor has nothing left to undo of
   * its own. In between — while there are still word-level steps to take — the
   * event falls through untouched, so fine-grained undo keeps working.
   *
   * Redo is ⌘⇧Z. ⌘Y is accepted too for people coming from Windows, but it is
   * NOT advertised: on macOS Chrome ⌘Y opens the browser's own History, and the
   * browser wins — pressing it in the app opens a tab instead of redoing.
   */
  useEffect(() => {
    if (viewState !== 'viewing') return;
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      const isRedo = key === 'y' || (key === 'z' && e.shiftKey);
      const isUndo = key === 'z' && !e.shiftKey;
      if (!isUndo && !isRedo) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (restoringIndex !== null) return;

      // The editor has no redo of its own, so this is additive rather than a
      // hijack.
      if (isRedo && canRedoVersion) {
        e.preventDefault();
        e.stopPropagation();
        handleRestore(historyIndex + 1);
        return;
      }
      // An AI run is undone whole. Otherwise the editor gets first refusal on
      // its own word-level steps, and the timeline picks up once those run out.
      const editorCanUndo = editorUndoDepth > 0 && currentCheckpoint?.kind !== 'ai';
      if (isUndo && canUndoVersion && !editorCanUndo) {
        e.preventDefault();
        e.stopPropagation();
        handleRestore(historyIndex - 1);
      }
    };
    // Capture phase, so the decision is made before the editor's own handler
    // sees the event — and so declining to act leaves it perfectly intact.
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [
    viewState,
    historyIndex,
    canUndoVersion,
    canRedoVersion,
    currentCheckpoint,
    restoringIndex,
    editorUndoDepth,
  ]);

  /** Pull the saved edit state back in and remount the editor to show it */
  const reloadEdits = async () => {
    if (!artipodId) return;
    const editsRes = await fetch(`/api/artipod/${artipodId}/edits`);
    const edits = await editsRes.json().catch(() => ({}));
    setCheckpoints(Array.isArray(edits.checkpoints) ? edits.checkpoints : []);
    setHistoryIndex(typeof edits.historyIndex === 'number' ? edits.historyIndex : -1);
    // Restoring clears the editor's word-level history server-side, so the
    // depth must follow it down rather than waiting for a remount to report.
    setEditorUndoDepth(Array.isArray(edits.undoStack) ? edits.undoStack.length : 0);
    if (edits.hasEdits && edits.editedWords) {
      setSavedEditorState({
        editedWords: edits.editedWords,
        undoStack: edits.undoStack || [],
        speedMarkers: edits.speedMarkers || [],
        defaultSpeed: edits.defaultSpeed ?? 1,
        savedAt: edits.savedAt,
      });
      setEditorEpoch((e) => e + 1);
    }
  };

  // AI edit: the model returns an operation list (delete / speed / move) which
  // the server validates and applies, saved as a reviewable proposal. Poll,
  // then reload the edits and remount the editor so the proposal — and a
  // one-step ⌘Z — appear.
  const handleAgentEdit = async (instructions?: string) => {
    if (!artipodId || agentStatus === 'running') return;
    const words = transcriptionResult?.transcript?.words;
    if (!words || words.length === 0) return;
    setAgentStatus('running');
    setError(null);

    try {
      const response = await fetch(`/api/artipod/${artipodId}/agent-edit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        },
        body: JSON.stringify({
          words,
          ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
          // Sent per request and never stored server-side. Its presence is also
          // what tells the server the shared budget is not being spent.
          ...(agentProvider ? { agent: agentProvider } : {}),
        }),
      });

      if (response.status === 401) {
        setAgentStatus('idle');
        setShowApiKeyModal(true);
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || data.error || `AI edit failed (${response.status})`);
      }

      const { jobId } = await response.json();

      // Poll until the proposal is written
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const statusRes = await fetch(`/api/agent-edit/status/${jobId}`);
        const status = await statusRes.json().catch(() => ({}));

        if (statusRes.ok && status.status === 'completed') {
          // Load the saved proposal and remount the editor to show it
          await reloadEdits();
          setAgentStatus('success');
          setTimeout(() => setAgentStatus('idle'), 3000);
          return;
        }

        if (!statusRes.ok) {
          throw new Error(status.message || status.error || 'AI edit failed');
        }
      }
    } catch (err) {
      console.error('AI edit failed:', err);
      setError(err instanceof Error ? err.message : 'AI edit failed');
      setAgentStatus('error');
      setTimeout(() => setAgentStatus('idle'), 3000);
    }
  };

  const handleApiKeySubmit = () => {
    const key = pendingApiKey.trim();
    if (key) {
      setApiKey(key);
      localStorage.setItem('pulseclip_api_key', key);
    }
    setShowApiKeyModal(false);
    setPendingApiKey('');
  };

  // Render API Key Modal
  /** A run needs a provider — this server's, or one this browser supplied. */
  const canRunAgent = agentAvailable || !!agentProvider;

  /** Transcription providers in the shape the ui Select wants. */
  const providerOptions = providers.map((p) => ({ value: p.id, label: p.displayName }));

  /**
   * The agent runs already on this pulse, oldest first, up to the version being
   * viewed. Not decoration: the server replays the LAST agent run into the next
   * prompt, so this is the context a follow-up instruction actually gets. Runs
   * ahead of the cursor are excluded — after an undo they describe a state that
   * is no longer on screen.
   */
  const agentTurns = checkpoints.filter(
    (cp) => cp.kind === 'ai' && (historyIndex < 0 || cp.index <= historyIndex)
  );

  /**
   * Open on the newest turn, the way any chat does — the run a follow-up
   * instruction builds on is the last one, and it is the one off the bottom of
   * a long history.
   */
  useEffect(() => {
    if (!showAgentModal) return;
    const body = agentScrollRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [showAgentModal, agentTurns.length]);

  /**
   * Speak the instruction instead of typing it. Transcribed by the same local
   * Whisper the pulse itself uses, so no key is spent and nothing leaves the
   * box. The text is APPENDED rather than replacing what is there — dictation
   * is usually a addition to a half-written thought, and clobbering someone's
   * typing would be unforgivable for a button that is easy to hit by accident.
   */
  const handleDictation = useCallback(async (blob: Blob) => {
    setDictationState('transcribing');
    try {
      const form = new FormData();
      form.append('audio', blob, 'dictation.webm');
      const res = await fetch('/api/dictate', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'Could not transcribe that');
      const text = (data.text || '').trim();
      if (!text) {
        setDictationState('idle');
        return;
      }
      setAgentInstructions((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
      setDictationState('idle');
    } catch (err) {
      setDictationState('error');
      setError(err instanceof Error ? err.message : 'Could not transcribe that');
      // Back to idle so the mic is usable again rather than stuck showing a failure.
      setTimeout(() => setDictationState('idle'), 2500);
    }
  }, []);

  /**
   * Which preset the SAVED provider is, not the half-filled draft. Matching on
   * the draft showed a tick against Groq while Anthropic was the thing actually
   * running, because the draft defaults to the first preset and only moves when
   * someone opens the menu.
   */
  const activePresetId = agentProvider
    ? (PROVIDER_PRESETS.find(
        (p) => p.id !== 'custom' && p.base === agentProvider.base && p.provider === agentProvider.provider
      )?.id ?? 'custom')
    : null;

  /** What the model line under the composer reads. */
  const agentModelLabel = agentProvider
    ? agentProvider.model
    : agentAvailable
      ? 'Shared AI'
      : 'No AI configured';

  const agentAccountLine = agentProvider
    ? `${agentProvider.model} · your account`
    : agentAvailable
      ? 'Shared AI · free for everyone here'
      : 'No AI configured';

  const renderAgentModal = () => (
    <Modal
      open={showAgentModal}
      onOpenChange={(open) => !open && setShowAgentModal(false)}
      size="md"
      // `relative` so the connect-your-own-AI pane can cover this dialog.
      className="relative"
    >
      <ModalHeader>
        <div className="flex min-w-0 items-center gap-3">
          <div
            aria-hidden="true"
            className="bg-primary-800 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white"
          >
            <SparklesIcon size="sm" />
          </div>
          <div className="min-w-0">
            <ModalTitle>AI Edit</ModalTitle>
            {/* Whose quota a run spends, stated before it is spent rather than
                after — the shared lane is rate-limited across everyone. */}
            <p className="text-muted-foreground m-0 truncate text-xs">{agentAccountLine}</p>
          </div>
        </div>
        <ModalClose />
      </ModalHeader>
      <ModalBody ref={agentScrollRef}>
        <div className="flex flex-col gap-3">
          {agentTurns.length > 0 ? (
            <div className="flex flex-col gap-3">
              {agentTurns.map((turn) => (
                <div key={turn.index} className="flex flex-col gap-2">
                  <div className="flex justify-end">
                    <ChatBubble variant="user">
                      <p className="m-0 text-sm">{turn.label}</p>
                    </ChatBubble>
                  </div>
                  <div className="flex items-start gap-2">
                    <div
                      aria-hidden="true"
                      className="bg-primary-800 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white"
                    >
                      <SparklesIcon size="sm" />
                    </div>
                    <ChatBubble variant="assistant">
                      {turn.summary && <p className="m-0 text-sm">{turn.summary}</p>}
                      <p className="text-muted-foreground m-0 text-xs">{describeAgentTurn(turn)}</p>
                    </ChatBubble>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground m-0 text-sm">
              Say what you want and the AI proposes it in the editor for you to review.
              It can cut, reorder, and change the pace. Nothing is exported, and ⌘Z
              undoes the whole proposal.
            </p>
          )}
        </div>
      </ModalBody>

      {/* The composer IS the action, as on every other AI surface — there is no
          separate confirm button, and ⏎ sends. Escape and ✕ still cancel. */}
      <ModalFooter className="flex-col items-stretch gap-2 border-t-0 px-3 pt-2 pb-2">
        {/* Above the composer rather than up in the body, exactly where AIChat
            puts them once a conversation has started: buried under a long
            history they are unreachable without scrolling past the thing they
            are meant to help you write. */}
        {canRunAgent && !agentInstructions.trim() && (
          <SuggestedActions
            actions={AGENT_STARTERS}
            onSelect={(action) => setAgentInstructions(action.prompt)}
            className="px-1"
          />
        )}
        <MessageComposer
          value={agentInstructions}
          onValueChange={setAgentInstructions}
          onSend={({ content }) => handleAgentConfirm(content)}
          placeholder={
            canRunAgent
              ? dictationState === 'recording'
                ? 'Listening…'
                : dictationState === 'transcribing'
                  ? 'Writing that down…'
                  : 'Tell it what to change, or hold the mic'
              : 'Pick an AI below to use AI edits'
          }
          disabled={!canRunAgent}
          variant="minimal"
          autoFocus
          showAttachmentPicker={false}
          showCameraButton={false}
          showCharacterCount={false}
          // Same slot AIChat uses for talk-to-text. Speaking an instruction is
          // the natural input here — people describe an edit far faster than
          // they type one.
          inputTrailing={
            <RecordButton
              variant="ghost"
              size="sm"
              showPulse={false}
              showWaveform
              showTranscriptionState
              transcriptionState={dictationState}
              maxDuration={120}
              disabled={!canRunAgent || dictationState === 'transcribing'}
              onRecordingStart={() => setDictationState('recording')}
              onRecordingComplete={handleDictation}
              onRecordingError={(err) => setError(err.message)}
              title="Hold to speak your instruction"
              aria-label="Dictate an instruction"
            />
          }
        />

        {/* The model lives on one thin line under the composer, the way Copilot
            and Claude put it — a control you reach for occasionally should not
            occupy a whole panel above the thing you actually came to type in. */}
        <div className="flex items-center gap-1 px-1">
          <Dropdown
            placement="top-start"
            open={showModelMenu}
            onOpenChange={setShowModelMenu}
            trigger={
              <button
                type="button"
                // Quiet on purpose, the way Copilot and Claude do it: this is a
                // statement about the current state, not an action competing for
                // attention. Deliberately NOT the bordered chip the starters
                // use — those insert text when clicked, this opens a menu, and
                // giving two unlike controls the same shape a row apart implies
                // they do the same thing. Rounded-full so the hover background
                // matches the shapes around it rather than introducing a corner.
                className="text-muted-foreground hover:text-foreground hover:bg-muted flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs transition-colors"
              >
                <SparklesIcon size="sm" className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{agentModelLabel}</span>
                <span aria-hidden="true">▾</span>
              </button>
            }
          >
            <DropdownContent>
              <DropdownLabel>Run this edit with</DropdownLabel>
              {agentAvailable && (
                <DropdownItem
                  icon={<PickedMark on={!agentProvider} />}
                  onClick={() => {
                    clearAgentProvider();
                    setAgentProvider(null);
                    setShowKeyForm(false);
                    setShowModelMenu(false);
                  }}
                >
                  Shared AI — free, rate-limited
                </DropdownItem>
              )}
              {PROVIDER_PRESETS.map((preset) => (
                <DropdownItem
                  key={preset.id}
                  icon={<PickedMark on={activePresetId === preset.id} />}
                  onClick={() => {
                    setProviderPreset(preset.id);
                    setProviderDraft((d) => ({
                      ...d,
                      provider: preset.provider,
                      base: preset.base,
                      model: preset.model,
                    }));
                    setShowKeyForm(true);
                    setShowModelMenu(false);
                  }}
                >
                  {preset.label}
                </DropdownItem>
              ))}
              {agentProvider && (
                <>
                  <DropdownSeparator />
                  <DropdownItem
                    variant="danger"
                    onClick={() => {
                      clearAgentProvider();
                      setAgentProvider(null);
                      setShowKeyForm(false);
                      setShowModelMenu(false);
                    }}
                  >
                    Forget my key
                  </DropdownItem>
                </>
              )}
            </DropdownContent>
          </Dropdown>
        </div>

      </ModalFooter>

      {/* Connecting an account is a small side task, so it gets a small card
          floating over a dimmed conversation rather than a whole second screen.
          The chat stays visible behind it — you can still see what you were
          doing, which a full takeover hides. Rendered inside this modal rather
          than as a nested one: stacked dialogs fight over focus and Escape.

          One way out, not three. Escape, the scrim and Cancel all do the same
          thing, so there is no separate Back button on top of them. */}
      {showKeyForm && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-black/40 p-4 backdrop-blur-[2px]"
          role="presentation"
          onClick={() => setShowKeyForm(false)}
          onKeyDown={(e) => {
            // Otherwise Escape closes the ENTIRE dialog and takes a half-typed
            // key with it. Here it means "back to the chat".
            if (e.key === 'Escape') {
              e.stopPropagation();
              setShowKeyForm(false);
            }
          }}
        >
          <div
            className="bg-card border-border flex w-full max-w-sm flex-col gap-3 rounded-xl border p-4 shadow-xl"
            // A group, not a nested role="dialog": it does not trap focus, and
            // claiming to be a second dialog inside the first misdescribes it
            // to a screen reader.
            role="group"
            aria-label="Use your own AI"
            // The card is not the scrim; clicking inside it must not dismiss.
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex min-w-0 items-center gap-3">
              <div
                aria-hidden="true"
                className="bg-primary-800 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white"
              >
                <SparklesIcon size="sm" />
              </div>
              <div className="min-w-0">
                <h2 className="m-0 text-base font-semibold">Use your own AI</h2>
                <p className="text-muted-foreground m-0 truncate text-xs">
                  {PROVIDER_PRESETS.find((p) => p.id === providerPreset)?.label ?? 'Custom'}
                </p>
              </div>
            </div>

            <p className="text-muted-foreground m-0 text-xs">
              Your key stays in this browser. It is sent with the request that uses it,
              and is never written to the server or into the pulse.
            </p>

            {providerPreset === 'custom' && (
              <Input
                label="Base URL"
                value={providerDraft.base}
                onChange={(e) => setProviderDraft((d) => ({ ...d, base: e.target.value }))}
                placeholder="https://…/v1"
              />
            )}
            <Input
              label="Model"
              value={providerDraft.model}
              onChange={(e) => setProviderDraft((d) => ({ ...d, model: e.target.value }))}
              placeholder="openai/gpt-oss-120b"
            />
            <Input
              label="API key"
              type="password"
              value={providerDraft.apiKey}
              onChange={(e) => setProviderDraft((d) => ({ ...d, apiKey: e.target.value }))}
              placeholder="sk-…"
              autoFocus
            />

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowKeyForm(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!providerDraft.apiKey.trim() || !providerDraft.model.trim()}
                onClick={() => {
                  const next = {
                    ...providerDraft,
                    base: providerDraft.base.trim(),
                    model: providerDraft.model.trim(),
                    apiKey: providerDraft.apiKey.trim(),
                  };
                  saveAgentProvider(next);
                  setAgentProvider(next);
                  setShowKeyForm(false);
                }}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );

  const renderExportModal = () => (
    <Modal open={showExportModal} onOpenChange={(open) => !open && setShowExportModal(false)} size="sm">
      <ModalHeader>
        <ModalTitle>Export Video</ModalTitle>
        <ModalClose />
      </ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm text-muted-foreground">
            Renders your edits into a new file and downloads it.
          </p>
          <Input
            label="File name"
            value={exportName}
            onChange={(e) => setExportName(e.target.value)}
            placeholder="File name"
            onKeyDown={(e) => e.key === 'Enter' && handleExportConfirm()}
            autoFocus
          />
          <Checkbox
            label="Burn captions into the video"
            checked={exportCaptions}
            onChange={(e) => setExportCaptions(e.target.checked)}
          />
          <Checkbox
            label="Add MIE title bar (lower-third)"
            checked={exportLowerThird}
            onChange={(e) => setExportLowerThird(e.target.checked)}
          />
          {exportLowerThird && (
            <Input
              label="Title bar text"
              value={exportTitle}
              onChange={(e) => setExportTitle(e.target.value)}
              placeholder="Shown in the on-screen title bar"
            />
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={() => setShowExportModal(false)}>
          Cancel
        </Button>
        <Button onClick={handleExportConfirm}>Export</Button>
      </ModalFooter>
    </Modal>
  );

  const renderApiKeyModal = () => (
    <Modal open={showApiKeyModal} onOpenChange={(open) => !open && setShowApiKeyModal(false)} size="sm">
      <ModalHeader>
        <ModalTitle>API Key Required</ModalTitle>
        <ModalClose />
      </ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm text-muted-foreground">
            Enter your API key to upload files and use transcription.
          </p>
          <Input
            type="password"
            label="API key"
            hideLabel
            value={pendingApiKey}
            onChange={(e) => setPendingApiKey(e.target.value)}
            placeholder="Enter API key"
            onKeyDown={(e) => e.key === 'Enter' && handleApiKeySubmit()}
            autoFocus
          />
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={() => setShowApiKeyModal(false)}>
          Cancel
        </Button>
        <Button onClick={handleApiKeySubmit}>Save</Button>
      </ModalFooter>
    </Modal>
  );

  // Render Featured Modal
  const handleRenameSubmit = async () => {
    const title = renameValue.trim();
    if (!title || !artipodId) return;
    try {
      const response = await fetch(`/api/artipod/${artipodId}/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Rename failed');
      }
      setPulseTitle(title);
      setShowRenameModal(false);
      // Refresh the homepage listing so the card picks the new title up
      fetch('/api/artipods')
        .then((res) => res.json())
        .then((data) => setAllPulses(data.artipods || []))
        .catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    }
  };

  const renderRenameModal = () => (
    <Modal open={showRenameModal} onOpenChange={(open) => !open && setShowRenameModal(false)} size="sm">
      <ModalHeader>
        <ModalTitle>Rename pulse</ModalTitle>
        <ModalClose />
      </ModalHeader>
      <ModalBody>
        <Input
          type="text"
          label="Title"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          placeholder="Give this pulse a name"
          onKeyDown={(e) => e.key === 'Enter' && handleRenameSubmit()}
          autoFocus
        />
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={() => setShowRenameModal(false)}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleRenameSubmit} disabled={!renameValue.trim()}>
          Save
        </Button>
      </ModalFooter>
    </Modal>
  );

  const renderFeaturedModal = () => (
    <Modal open={showFeaturedModal} onOpenChange={(open) => !open && setShowFeaturedModal(false)} size="sm">
      <ModalHeader>
        <ModalTitle>{isCurrentPulseFeatured ? 'Edit Featured Pulse' : 'Mark as Featured'}</ModalTitle>
        <ModalClose />
      </ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-4">
          <p className="m-0 text-sm text-muted-foreground">
            Set a display title and optional thumbnail for this featured pulse.
          </p>
          <Input
            type="text"
            label="Title"
            value={featuredTitle}
            onChange={(e) => setFeaturedTitle(e.target.value)}
            placeholder="Enter pulse title"
            onKeyDown={(e) => e.key === 'Enter' && handleFeaturedSubmit()}
            autoFocus
          />
          <Input
            type="url"
            label="Thumbnail URL (optional)"
            value={featuredThumbnail}
            onChange={(e) => setFeaturedThumbnail(e.target.value)}
            placeholder="https://example.com/thumbnail.jpg"
          />
          {featuredThumbnail && (
            <div className="overflow-hidden rounded-lg border border-border">
              <img
                src={featuredThumbnail}
                alt="Thumbnail preview"
                className="block max-h-40 w-full object-cover"
                onError={(e) => (e.currentTarget.style.display = 'none')}
              />
            </div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={() => setShowFeaturedModal(false)}>
          Cancel
        </Button>
        <Button onClick={handleFeaturedSubmit}>Save</Button>
      </ModalFooter>
    </Modal>
  );

  // Loading view - when restoring pulse from URL
  if (viewState === 'loading') {
    return (
      <div className="app app--upload">
        <div className="flex min-h-screen flex-col items-center justify-center gap-6">
          <h1 className="m-0 flex items-center gap-2 text-2xl font-semibold text-foreground">
            <AudioLines className="h-7 w-7 text-primary-800 dark:text-primary-400" aria-hidden="true" />
            PulseClip
          </h1>
          <SpinnerWithLabel size="lg" label="Loading pulse..." />
        </div>
      </div>
    );
  }

  // Upload view - centered upload area
  if (viewState === 'upload') {
    return (
      <div className="app app--upload">
        {renderApiKeyModal()}
        {renderFeaturedModal()}
      {renderRenameModal()}
        
        {/* Sticky header banner */}
        <header className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border bg-background/95 px-6 py-3 backdrop-blur">
          {/* items-center, not items-baseline: the h1 is a flex row whose
              first item is an SVG icon, and a flex container's baseline is
              its first item's — an SVG baseline is its bottom edge, which
              dragged the tagline ~6px below the title's real text baseline */}
          <div className="flex items-center gap-3">
            <h1 className="m-0 flex items-center gap-2 text-lg font-semibold text-foreground">
              <AudioLines className="h-5 w-5 shrink-0 self-center text-primary-800 dark:text-primary-400" aria-hidden="true" />
              PulseClip
            </h1>
            <p className="m-0 hidden text-sm text-muted-foreground md:block">Word-level transcripts for audio &amp; video</p>
          </div>
          <nav className="flex flex-wrap items-center gap-1" aria-label="Project links">
            <BrandSelector />
            <ThemeToggle
              mode="three-way"
              variant="ghost"
              aria-label="Toggle color theme"
            />
            <a href="https://github.com/mieweb/pulseclip" target="_blank" rel="noopener noreferrer" className="rounded-md px-2 py-1.5 text-sm text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-foreground">
              GitHub
            </a>
            <a href="https://github.com/mieweb/pulseclip/blob/main/IMPLEMENTATION.md" target="_blank" rel="noopener noreferrer" className="rounded-md px-2 py-1.5 text-sm text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-foreground">
              Docs
            </a>
            <a href="https://github.com/mieweb/pulseclip/issues/new" target="_blank" rel="noopener noreferrer" className="rounded-md px-2 py-1.5 text-sm text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-foreground">
              Report Issue
            </a>
            {versionInfo && (
              <span className="ml-2 flex items-center gap-2 border-l border-border pl-3 text-xs">
                <a
                  href={versionInfo.commitUrl || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-muted-foreground no-underline hover:text-foreground"
                  title={`Commit: ${versionInfo.commitHash}`}
                >
                  {versionInfo.commitHash.slice(0, 7)}
                </a>
                {versionInfo.commitDate && (
                  <a
                    href="https://github.com/mieweb/pulseclip/blob/main/RELEASE_NOTES.md"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground no-underline hover:text-foreground"
                    title="Release Notes"
                  >
                    {new Date(versionInfo.commitDate).toLocaleDateString()}
                  </a>
                )}
              </span>
            )}
          </nav>
        </header>

        <main className="mx-auto w-full max-w-5xl px-6 py-10 xl:max-w-6xl 2xl:max-w-7xl">
          <div className="flex flex-col gap-12">
            {/* Featured pulses - prominent, with the rest of the library behind Show all */}
            {(featuredPulses.length > 0 || allPulses.length > 0) && (
              <section aria-label="Featured pulses">
                {featuredPulses.length > 0 && (
                  <>
                    <h2 className="m-0 mb-4 text-center text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                      Featured Pulses
                    </h2>
                    <div className="flex flex-wrap justify-center gap-4">
                      {featuredPulses.map((pulse) => (
                        <FeaturedPulseCard
                          key={pulse.artipodId}
                          pulse={pulse}
                          onOpen={() => navigate(`/artipod/${pulse.artipodId}`)}
                        />
                      ))}
                    </div>
                  </>
                )}
                {(() => {
                  // Featured plus THIS browser's uploads — visitors don't
                  // browse each other's videos from the homepage
                  const mine = myUploadIds();
                  const morePulses = allPulses.filter(
                    (p) => !p.featured && mine.has(p.artipodId)
                  );
                  if (morePulses.length === 0) return null;
                  const moreCards = morePulses.map((p) => (
                    <FeaturedPulseCard
                      key={p.artipodId}
                      pulse={{
                        artipodId: p.artipodId,
                        title:
                          p.title ||
                          `Uploaded ${new Date(p.uploadedAt).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}`,
                        thumbnail: p.thumbnail,
                        addedAt: p.uploadedAt,
                      }}
                      onOpen={() => navigate(`/artipod/${p.artipodId}`)}
                    />
                  ));
                  return (
                    <div className="mt-4 flex flex-col items-center gap-4">
                      {showAllPulses &&
                        (morePulses.length > 8 ? (
                          <PulseCarousel>{moreCards}</PulseCarousel>
                        ) : (
                          <div className="flex flex-wrap justify-center gap-4">{moreCards}</div>
                        ))}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setShowAllPulses((v) => !v)}
                        aria-expanded={showAllPulses}
                      >
                        {showAllPulses ? 'Hide' : `My uploads (${morePulses.length})`}
                      </Button>
                    </div>
                  );
                })()}
              </section>
            )}

            {/* Compact upload area */}
            <section aria-label="Upload">
              <h2 className="m-0 mb-4 text-center text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                Upload Your Own
              </h2>
              <div className="grid items-stretch gap-6 md:grid-cols-2">
                <PulseCamButton onError={(err) => setError(err)} />
                <FileUpload
                  onFileUploaded={handleFileUploaded}
                  onInspected={(report) =>
                    setUploadWarning(report.ok ? null : { report, artipodId: null })
                  }
                  disabled={false}
                  apiKey={apiKey}
                  onAuthError={handleAuthError}
                />
              </div>
            </section>

            {/* Features for first-time visitors */}
            <section aria-label="Features" className="grid gap-4 md:grid-cols-3">
              {FEATURES.map(({ Icon, title, desc }) => (
                <Card key={title} padding="md" className="text-center">
                  <Icon className="mx-auto h-6 w-6 text-primary-800 dark:text-primary-400" aria-hidden="true" />
                  <h3 className="m-0 mt-3 text-sm font-semibold text-foreground">{title}</h3>
                  <p className="m-0 mt-1 text-sm text-muted-foreground">{desc}</p>
                </Card>
              ))}
            </section>

            {error && <Alert variant="danger">{error}</Alert>}
          </div>
        </main>
      </div>
    );
  }

  // Ready/Transcribing/Viewing states - split view
  return (
    <div className="app app--split">
      {renderApiKeyModal()}
      {renderFeaturedModal()}
      {renderRenameModal()}
      {renderExportModal()}
      {renderAgentModal()}
      {/* Compact toolbar */}
      <header className="app__toolbar">
        <div className="app__toolbar-left">
          <button
            className="app__menu-btn"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Menu"
          >
            ☰
          </button>
          <span className="app__filename" title={mediaFilename}>
            {pulseTitle || mediaFilename}
          </span>
          {versionInfo?.commitHash && (
            (() => {
              const serverHash = versionInfo.commitHash.slice(0, 7);
              const clientHash = typeof __BUILD_COMMIT_HASH__ !== 'undefined' && __BUILD_COMMIT_HASH__ 
                ? __BUILD_COMMIT_HASH__.slice(0, 7) 
                : null;
              const hashesMatch = clientHash === serverHash;
              
              if (hashesMatch || !clientHash) {
                return (
                  <a 
                    href={versionInfo.commitUrl || '#'} 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    className="app__toolbar-version"
                    title={`Version: ${serverHash}`}
                  >
                    {serverHash}
                  </a>
                );
              } else {
                return (
                  <div className="app__toolbar-versions">
                    <a 
                      href={`https://github.com/mieweb/pulseclip/commit/${clientHash}`}
                      target="_blank" 
                      rel="noopener noreferrer" 
                      className="app__toolbar-version app__toolbar-version--client"
                      title={`Client version: ${clientHash}`}
                    >
                      C:{clientHash}
                    </a>
                    <a 
                      href={versionInfo.commitUrl || '#'} 
                      target="_blank" 
                      rel="noopener noreferrer" 
                      className="app__toolbar-version app__toolbar-version--server"
                      title={`Server version: ${serverHash}`}
                    >
                      S:{serverHash}
                    </a>
                  </div>
                );
              }
            })()
          )}
        </div>

        <div className="app__toolbar-right">
          <BrandSelector />
          <ThemeToggle
            mode="three-way"
            variant="ghost"
            aria-label="Toggle color theme"
          />
          {viewState === 'ready' && (
            <>
              <Select
                options={providerOptions}
                value={selectedProvider}
                onValueChange={setSelectedProvider}
                disabled={providers.length === 0}
                size="sm"
                label="Transcription provider"
                hideLabel
                className="w-52"
              />
              <Button
                size="sm"
                onClick={() => handleTranscribe(false)}
                disabled={!selectedProvider}
                isLoading={transcribing || transcribingAsync}
                loadingText="Transcribing…"
              >
                Transcribe
              </Button>
            </>
          )}

          {viewState === 'transcribing' && (
            <span className="app__status">
              {transcribingAsync
                ? 'Transcribing large file — this may take several minutes...'
                : 'Transcribing...'}
            </span>
          )}

          {viewState === 'viewing' && (
            <>
              <Select
                options={providerOptions}
                value={selectedProvider}
                onValueChange={setSelectedProvider}
                disabled={providers.length === 0}
                size="sm"
                label="Provider used when re-transcribing"
                hideLabel
                className="w-52"
              />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={openAgentModal}
                  isLoading={agentStatus === 'running'}
                  loadingText="AI editing…"
                  title="Tell the AI what to cut, reorder, or speed up"
                  aria-label="AI edit transcript"
                >
                  {agentStatus === 'success' ? 'AI edited ✓' :
                   agentStatus === 'error' ? 'AI edit failed' :
                   '✨ AI edit'}
                </Button>
              {/* Self-gating: only ever non-empty once something has been edited */}
              {checkpoints.length > 1 && (
                <>
                  <Button
                    size="sm"
                    // Secondary at rest, not ghost. History opens a surface, the
                    // same job as ✨ AI edit beside it, so it should carry the
                    // same weight — ghost left it reading as a label until you
                    // happened to hover it. Ghost stays right for Edit/Del/Cut
                    // inside the editor, where a row of filled buttons is noise.
                    variant="secondary"
                    onClick={() => setShowHistoryPanel((v) => !v)}
                    title="Review, compare, or roll back to an earlier version"
                    aria-label="Edit history"
                    aria-pressed={showHistoryPanel}
                  >
                    🕘 History ({checkpoints.length - 1})
                  </Button>
                </>
              )}
              <Button
                size="sm"
                onClick={openExportModal}
                isLoading={exportStatus === 'exporting'}
                loadingText="Exporting…"
                title="Render the edited video to a new file"
                aria-label="Export edited video"
              >
                {exportStatus === 'success' ? 'Exported ✓' :
                 exportStatus === 'error' ? 'Export failed' :
                 'Export'}
              </Button>
              <button
                className={`app__icon-btn app__data-toggle ${viewMode === 'data' ? 'app__data-toggle--active' : ''}`}
                onClick={() => setViewMode(viewMode === 'data' ? 'transcript' : 'data')}
                title={viewMode === 'data' ? 'Show transcript' : 'Show Artipod Folder'}
                aria-label={viewMode === 'data' ? 'Show transcript' : 'Show Artipod Folder'}
              >
                📁
              </button>
              {isCurrentPulseFeatured && cursorTimestampMs !== null && (
                <button
                  className={`app__icon-btn app__thumbnail-btn app__thumbnail-btn--${thumbnailStatus}`}
                  onClick={async () => {
                    if (thumbnailStatus !== 'loading') {
                      setThumbnailStatus('loading');
                      const success = await handleCaptureThumbnail(cursorTimestampMs);
                      setThumbnailStatus(success ? 'success' : 'error');
                      setTimeout(() => setThumbnailStatus('idle'), 2000);
                    }
                  }}
                  disabled={thumbnailStatus === 'loading'}
                  aria-label="Capture thumbnail at current position"
                  title="Set this frame as demo thumbnail"
                >
                  {thumbnailStatus === 'loading' ? '⏳' :
                   thumbnailStatus === 'success' ? '✅' :
                   thumbnailStatus === 'error' ? '❌' :
                   '📷'}
                </button>
              )}
              <button
                className="app__icon-btn app__retranscribe-btn"
                onClick={handleRetranscribe}
                title="Re-transcribe (ignore cache)"
                aria-label="Re-transcribe"
              >
                🔄
              </button>
            </>
          )}
        </div>
      </header>

      {/* Dropdown menu */}
      {menuOpen && (
        <div className="app__menu">
          <button className="app__menu-item" onClick={handleNewPulse}>
            📁 New Pulse
          </button>
          {artipodId && (
            <>
              {isCurrentPulseFeatured ? (
                <>
                  <button className="app__menu-item" onClick={() => {
                    const existingPulse = featuredPulses.find((p) => p.artipodId === artipodId);
                    setFeaturedTitle(existingPulse?.title || mediaFilename);
                    setFeaturedThumbnail(existingPulse?.thumbnail || '');
                    setShowFeaturedModal(true);
                    setMenuOpen(false);
                  }}>
                    ✏️ Edit Featured
                  </button>
                  <button className="app__menu-item" onClick={handleToggleFeatured}>
                    ⭐ Remove Featured
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="app__menu-item"
                    onClick={() => {
                      setRenameValue(pulseTitle || '');
                      setShowRenameModal(true);
                      setMenuOpen(false);
                    }}
                  >
                    ✏️ Rename Pulse
                  </button>
                  <button className="app__menu-item" onClick={handleToggleFeatured}>
                    ⭐ Mark as Featured
                  </button>
                </>
              )}
              <button className="app__menu-item app__menu-item--danger" onClick={handleDeletePulse}>
                🗑️ Delete Pulse
              </button>
            </>
          )}
          <button
            className="app__menu-item"
            onClick={() => {
              const newState = toggleDebug();
              setDebugMode(newState);
              setMenuOpen(false);
            }}
          >
            {debugMode ? '🔇 Disable Debug' : '🔊 Enable Debug'}
          </button>
        </div>
      )}

      {/* Playback warning for a file that broke the upload contract */}
      {uploadWarning &&
        (uploadWarning.artipodId === null || uploadWarning.artipodId === artipodId) && (
          <UploadContractWarning
            className="mx-4 mb-4 text-left"
            report={uploadWarning.report}
            onDismiss={() => setUploadWarning(null)}
          />
        )}

      {/* Error banner */}
      {error && (
        <div className="app__error-banner">
          <strong>Error:</strong> {error}
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* Content area: MediaEditor owns the whole pane when viewing;
          the standalone player + split bar serve the pre-transcription states */}
      <main
        className={`app__content${isDragging ? ' app__content--dragging' : ''}${
          showHistoryPanel && viewState === 'viewing' && viewMode !== 'data'
            ? ' app__content--with-history'
            : ''
        }`}
        ref={contentRef}
      >
        {viewState === 'viewing' && transcriptionResult && editsLoaded ? (
          <>
            <div
              className={
                viewMode === 'data'
                  ? 'app__hidden-editor'
                  : `app__editor-pane${showHistoryPanel ? ' app__editor-pane--with-history' : ''}`
              }
              // The first touch inside the editor is what turns a rebuilt
              // transcript back into an editing session someone is responsible
              // for. Capture phase so it registers before the editor handles it.
              onPointerDownCapture={() => { transcriptRebuildRef.current = false; }}
              onKeyDownCapture={() => { transcriptRebuildRef.current = false; }}
            >
              <MediaEditor
                key={editorEpoch}
                src={mediaUrl!}
                transcript={transcriptionResult.transcript}
                initialEditedWords={savedEditorState?.editedWords}
                initialUndoStack={savedEditorState?.undoStack}
                initialSpeedMarkers={savedEditorState?.speedMarkers}
                initialDefaultSpeed={savedEditorState?.defaultSpeed}
                onEditorStateChange={saveEditorState}
                onHasEditsChange={setHasEdits}
                onCursorTimestampChange={setCursorTimestampMs}
                onEditedWordsRender={handleEditedWordsRender}
                onSpeedStateChange={handleSpeedStateChange}
                // The editor's Undo is word-level and runs out; these let the
                // same control keep going into the version timeline rather than
                // putting a second Undo somewhere else on screen.
                canUndoBeyond={canUndoVersion && restoringIndex === null}
                onUndoBeyond={() => handleRestore(historyIndex - 1)}
                undoBeyondLabel={checkpoints[historyIndex - 1]?.label}
                // Only offered once this pulse actually has versions to move
                // between — the same gate as the History button. Before that
                // there is nothing to redo, and a permanently greyed control
                // reads as broken rather than inapplicable.
                canRedo={canRedoVersion && restoringIndex === null}
                onRedo={
                  checkpoints.length > 1
                    ? () => handleRestore(historyIndex + 1)
                    : undefined
                }
                redoLabel={checkpoints[historyIndex + 1]?.label}
                playerRef={playerRef}
              />
            </div>
            {/* Beside the editor rather than over it: comparing a version with
                what is on screen is the point, and a modal hides the thing you
                are comparing against. */}
            {showHistoryPanel && viewMode !== 'data' && artipodId && (
              <EditHistoryPanel
                checkpoints={checkpoints}
                historyIndex={historyIndex}
                artipodId={artipodId}
                apiKey={apiKey}
                onRestore={handleRestore}
                restoringIndex={restoringIndex}
                onRenamed={refreshHistory}
                onClose={() => setShowHistoryPanel(false)}
              />
            )}
            {viewMode === 'data' && (
              <TranscriptDataView
                transcript={transcriptionResult.transcript}
                editedWords={latestEditedWords}
                dataSource={dataSource}
                dataFormat={dataFormat}
                onDataSourceChange={setDataSource}
                onDataFormatChange={setDataFormat}
              />
            )}
          </>
        ) : (
          <>
            <div 
              className="app__media-pane" 
              style={{ height: `${splitPosition}%`, maxHeight: 'none' }}
            >
              {mediaUrl && <MediaPlayer src={mediaUrl} mediaElementRef={mediaRef} aria-label="Pulse media" />}
            </div>

            <div 
              className="app__split-bar"
              onMouseDown={handleSplitMouseDown}
              onTouchStart={handleSplitTouchStart}
              role="separator"
              aria-label="Resize media and transcript panes"
              aria-orientation="horizontal"
            >
              <div className="app__split-bar-handle" />
            </div>

            <div className="app__transcript-pane">
              {viewState === 'ready' && (
                <div className="app__ready-message">
                  <p>Ready to transcribe</p>
                  <p className="app__ready-hint">
                    Click "Transcribe" to start processing your media file
                  </p>
                </div>
              )}

              {viewState === 'transcribing' && (
                <div className="app__loading">
                  <div className="app__spinner" />
                  <p>Processing with {providers.find(p => p.id === selectedProvider)?.displayName}...</p>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
