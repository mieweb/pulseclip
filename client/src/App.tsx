import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FileUpload } from './components/FileUpload';
import { PulseCamButton } from './components/PulseCamButton';
import { MediaPlayer, type MediaPlayerRef } from '@mieweb/ui/components/MediaPlayer';
import { MediaEditor } from '@mieweb/ui/components/MediaEditor';
import { ThemeToggle } from '@mieweb/ui/components/ThemeProvider';
import { Card, CardContent, CardMedia } from '@mieweb/ui/components/Card';
import { Button } from '@mieweb/ui/components/Button';
import { Alert } from '@mieweb/ui/components/Alert';
import { Input } from '@mieweb/ui/components/Input';
import { Modal, ModalHeader, ModalTitle, ModalClose, ModalBody, ModalFooter } from '@mieweb/ui/components/Modal';
import { SpinnerWithLabel } from '@mieweb/ui/components/Spinner';
import { AudioLines, Film, Zap, Scissors, Type } from 'lucide-react';
import { BrandSelector, restoreBrand } from './components/BrandSelector';
import { TranscriptDataView } from './components/TranscriptDataView';
import type { Provider, TranscriptionResult, FeaturedPulse, EditableWord } from './types';
import { isDebugEnabled, toggleDebug } from './debug';
import './App.scss';

type ViewState = 'upload' | 'loading' | 'ready' | 'transcribing' | 'viewing';

/** Saved editor state from server */
interface SavedEditorState {
  editedWords: EditableWord[];
  undoStack: EditableWord[][];
  savedAt: string;
}

/** Version info from server */
interface VersionInfo {
  commitHash: string;
  commitDate: string;
  commitUrl: string;
}

declare const __BUILD_COMMIT_HASH__: string | undefined;

/** Landing-page feature highlights */
const FEATURES = [
  { Icon: Zap, title: 'Transcribed Instantly', desc: 'Upload and get word-level transcripts in seconds' },
  { Icon: Scissors, title: 'Word-Level Editing', desc: 'Delete fillers and dead air with a single click' },
  { Icon: Type, title: 'Edit Like Text', desc: 'Cut and paste video as simply as a text editor' },
] as const;

/** Featured pulse card with graceful fallback when the thumbnail is missing or unreachable */
function FeaturedPulseCard({ pulse, onOpen }: { pulse: FeaturedPulse; onOpen: () => void }) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const showThumb = pulse.thumbnail && !thumbFailed;
  return (
    <a
      href={`/artipod/${pulse.artipodId}`}
      className="block w-56 no-underline"
      onClick={(e) => {
        e.preventDefault();
        onOpen();
      }}
    >
      <Card interactive padding="none" className="overflow-hidden">
        {showThumb ? (
          <CardMedia src={pulse.thumbnail} alt="" aspectRatio="video" onError={() => setThumbFailed(true)} />
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
  const [isCurrentPulseFeatured, setIsCurrentPulseFeatured] = useState(false);
  const [showFeaturedModal, setShowFeaturedModal] = useState(false);
  const [featuredTitle, setFeaturedTitle] = useState('');
  const [featuredThumbnail, setFeaturedThumbnail] = useState('');
  const [splitPosition, setSplitPosition] = useState(50); // Percentage for media pane height
  const [isDragging, setIsDragging] = useState(false);
  const [savedEditorState, setSavedEditorState] = useState<SavedEditorState | null>(null);
  const [editsLoaded, setEditsLoaded] = useState(false);
  const [cursorTimestampMs, setCursorTimestampMs] = useState<number | null>(null);
  const [latestEditedWords, setLatestEditedWords] = useState<EditableWord[]>([]);
  const [exportStatus, setExportStatus] = useState<'idle' | 'exporting' | 'success' | 'error'>('idle');
  const [thumbnailStatus, setThumbnailStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement>(null);
  const playerRef = useRef<MediaPlayerRef>(null);
  /** The live media element — from MediaEditor's player when viewing, else the standalone player */
  const getMediaElement = () => playerRef.current?.mediaElement ?? mediaRef.current;
  const contentRef = useRef<HTMLElement>(null);
  const hasAutoTranscribed = useRef(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      })
      .catch((err) => console.error('Failed to fetch version info:', err));
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
        if (data.hasEdits && data.editedWords) {
          console.log(`Loaded saved edits for artipod ${artipodId}: ${data.editedWords.length} words, ${data.undoStack?.length || 0} undo states`);
          setSavedEditorState({
            editedWords: data.editedWords,
            undoStack: data.undoStack || [],
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

  // Save editor state (debounced)
  const saveEditorState = useCallback((editedWords: EditableWord[], undoStack: EditableWord[][]) => {
    if (!artipodId || !apiKey) return;
    
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
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          editedWords,
          undoStack,
          savedAt: new Date().toISOString(),
        }),
      })
        .then((res) => {
          if (!res.ok) {
            console.error('Failed to save edits:', res.status);
          }
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
    // Reset auto-transcribe flag for new file
    hasAutoTranscribed.current = false;
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
  const handleExport = async () => {
    if (!artipodId || exportStatus === 'exporting') return;
    setExportStatus('exporting');
    setError(null);

    try {
      const response = await fetch(`/api/artipod/${artipodId}/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        // Send live editor state; with no edits yet, let the server fall back to edits.json
        body: JSON.stringify(latestEditedWords.length > 0 ? { editedWords: latestEditedWords } : {}),
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
          const link = document.createElement('a');
          link.href = status.downloadUrl;
          link.download = status.filename || 'export.mp4';
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
        
        {/* Sticky header banner */}
        <header className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border bg-background/95 px-6 py-3 backdrop-blur">
          <div className="flex items-baseline gap-3">
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

        <main className="mx-auto w-full max-w-5xl px-6 py-10">
          <div className="flex flex-col gap-12">
            {/* Featured pulses - prominent */}
            {featuredPulses.length > 0 && (
              <section aria-label="Featured pulses">
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
              </section>
            )}

            {/* Compact upload area */}
            <section aria-label="Upload">
              <h2 className="m-0 mb-4 text-center text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                Upload Your Own
              </h2>
              <div className="grid items-stretch gap-6 md:grid-cols-2">
                <PulseCamButton onError={(err) => setError(err)} />
                <FileUpload onFileUploaded={handleFileUploaded} disabled={false} apiKey={apiKey} onAuthError={handleAuthError} />
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
            {mediaFilename}
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
              <select
                className="app__provider-dropdown"
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
                disabled={providers.length === 0}
                aria-label="Transcription Provider"
              >
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.displayName}
                  </option>
                ))}
              </select>
              <button
                className="app__transcribe-btn"
                onClick={() => handleTranscribe(false)}
                disabled={!selectedProvider}
              >
                Transcribe
              </button>
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
              <select
                className="app__provider-dropdown"
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
                disabled={providers.length === 0}
                aria-label="Transcription Provider"
                title="Provider used when re-transcribing"
              >
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.displayName}
                  </option>
                ))}
              </select>
              <button
                className="app__transcribe-btn"
                onClick={handleExport}
                disabled={exportStatus === 'exporting'}
                title="Render the edited video to a new file"
                aria-label="Export edited video"
              >
                {exportStatus === 'exporting' ? 'Exporting…' :
                 exportStatus === 'success' ? 'Exported ✓' :
                 exportStatus === 'error' ? 'Export failed' :
                 'Export'}
              </button>
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
                <button className="app__menu-item" onClick={handleToggleFeatured}>
                  ⭐ Mark as Featured
                </button>
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

      {/* Error banner */}
      {error && (
        <div className="app__error-banner">
          <strong>Error:</strong> {error}
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* Content area: MediaEditor owns the whole pane when viewing;
          the standalone player + split bar serve the pre-transcription states */}
      <main className={`app__content${isDragging ? ' app__content--dragging' : ''}`} ref={contentRef}>
        {viewState === 'viewing' && transcriptionResult && editsLoaded ? (
          <>
            <div className={viewMode === 'data' ? 'app__hidden-editor' : 'app__editor-pane'}>
              <MediaEditor
                src={mediaUrl!}
                transcript={transcriptionResult.transcript}
                initialEditedWords={savedEditorState?.editedWords}
                initialUndoStack={savedEditorState?.undoStack}
                onEditorStateChange={saveEditorState}
                onHasEditsChange={setHasEdits}
                onCursorTimestampChange={setCursorTimestampMs}
                onEditedWordsRender={setLatestEditedWords}
                playerRef={playerRef}
              />
            </div>
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
