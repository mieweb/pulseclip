import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FileUpload } from './components/FileUpload';
import { PulseCamButton } from './components/PulseCamButton';
import { MediaPlayer, type MediaPlayerRef } from '@mieweb/ui/components/MediaPlayer';
import { MediaEditor } from '@mieweb/ui/components/MediaEditor';
import { ThemeToggle } from '@mieweb/ui/components/ThemeProvider';
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
  const [featuredPulses, setFeaturedPulses] = useState<FeaturedPulse[]>([]);
  const [isCurrentPulseFeatured, setIsCurrentPulseFeatured] = useState(false);
  const [showFeaturedModal, setShowFeaturedModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [isCreatingShare, setIsCreatingShare] = useState(false);
  const [featuredTitle, setFeaturedTitle] = useState('');
  const [featuredThumbnail, setFeaturedThumbnail] = useState('');
  const [splitPosition, setSplitPosition] = useState(50); // Percentage for media pane height
  const [isDragging, setIsDragging] = useState(false);
  const [savedEditorState, setSavedEditorState] = useState<SavedEditorState | null>(null);
  const [editsLoaded, setEditsLoaded] = useState(false);
  const [cursorTimestampMs, setCursorTimestampMs] = useState<number | null>(null);
  const [latestEditedWords, setLatestEditedWords] = useState<EditableWord[]>([]);
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
  }, [artipodId]);

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
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mediaUrl,
          providerId: selectedProvider,
          skipCache,
          options: {
            speakerLabels: false,
            speech_models: ["universal-3-5-pro"],
          },
        }),
      });

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
    if (artipodId) {
      fetch(`/api/artipod/${artipodId}/edits`, {
        method: 'DELETE',
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

  const handleToggleFeatured = async () => {
    if (!artipodId) return;

    if (isCurrentPulseFeatured) {
      // Remove from featured
      try {
        const response = await fetch(`/api/featured/${artipodId}`, {
          method: 'DELETE',
        });

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
    if (!artipodId) return;

    try {
      const response = await fetch('/api/featured', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          artipodId,
          title: featuredTitle.trim() || mediaFilename,
          thumbnail: featuredThumbnail.trim() || undefined,
        }),
      });

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

  const handleOpenShareModal = () => {
    setShareUrl(null);
    setShareError(null);
    setShowShareModal(true);
  };

  const handleCreateShare = async () => {
    if (!artipodId) return;

    setIsCreatingShare(true);
    setShareError(null);
    try {
      const response = await fetch(`/api/artipod/${artipodId}/share`, {
        method: 'POST',
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to create share link');
      }
      setShareUrl(data.url);
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Failed to create share link');
    } finally {
      setIsCreatingShare(false);
    }
  };

  const handleDeletePulse = async () => {
    if (!artipodId) return;

    // Confirm deletion
    if (!window.confirm(`Are you sure you want to delete this pulse? This cannot be undone.`)) {
      return;
    }

    try {
      const response = await fetch(`/api/artipod/${artipodId}`, {
        method: 'DELETE',
      });

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
    if (!media || !artipodId) return false;

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
        },
        body: JSON.stringify({
          imageData,
          artipodId,
        }),
      });

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

  // Render Featured Modal
  const renderFeaturedModal = () => {
    if (!showFeaturedModal) return null;
    return (
      <div className="api-key-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="featured-modal-title">
        <div className="api-key-modal featured-modal">
          <h3 id="featured-modal-title">{isCurrentPulseFeatured ? 'Edit Featured Pulse' : 'Mark as Featured'}</h3>
          <p>Set a display title and optional thumbnail for this featured pulse.</p>
          <label className="featured-modal__label">
            Title
            <input
              type="text"
              value={featuredTitle}
              onChange={(e) => setFeaturedTitle(e.target.value)}
              placeholder="Enter pulse title"
              className="api-key-modal__input"
              onKeyDown={(e) => e.key === 'Enter' && handleFeaturedSubmit()}
              autoFocus
            />
          </label>
          <label className="featured-modal__label">
            Thumbnail URL (optional)
            <input
              type="url"
              value={featuredThumbnail}
              onChange={(e) => setFeaturedThumbnail(e.target.value)}
              placeholder="https://example.com/thumbnail.jpg"
              className="api-key-modal__input"
            />
          </label>
          {featuredThumbnail && (
            <div className="featured-modal__preview">
              <img src={featuredThumbnail} alt="Thumbnail preview" onError={(e) => (e.currentTarget.style.display = 'none')} />
            </div>
          )}
          <div className="api-key-modal__actions">
            <button onClick={() => setShowFeaturedModal(false)} className="api-key-modal__cancel">
              Cancel
            </button>
            <button onClick={handleFeaturedSubmit} className="api-key-modal__submit">
              Save
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderShareModal = () => {
    if (!showShareModal) return null;
    return (
      <div className="api-key-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="share-modal-title">
        <div className="api-key-modal share-modal">
          {shareUrl ? (
            <>
              <h3 id="share-modal-title">Share link created</h3>
              <p>Anyone with this link can view this recording.</p>
              <a className="share-modal__link" href={shareUrl} target="_blank" rel="noopener noreferrer">
                {shareUrl}
              </a>
              <div className="api-key-modal__actions">
                <button onClick={() => setShowShareModal(false)} className="api-key-modal__submit">
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <h3 id="share-modal-title">Share recording?</h3>
              <p>
                These recordings may contain protected health information (PHI). Sharing a recording containing PHI with a third party may violate HIPAA.
              </p>
              {shareError && <p className="share-modal__error" role="alert">{shareError}</p>}
              <div className="api-key-modal__actions">
                <button onClick={() => setShowShareModal(false)} className="api-key-modal__cancel" disabled={isCreatingShare}>
                  No
                </button>
                <button onClick={handleCreateShare} className="api-key-modal__submit" disabled={isCreatingShare}>
                  {isCreatingShare ? 'Creating...' : 'Yes, create link'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  // Loading view - when restoring pulse from URL
  if (viewState === 'loading') {
    return (
      <div className="app app--upload">
        <div className="app__upload-container">
          <h1 className="app__title">🎙️ PulseClip</h1>
          <div className="app__loading">
            <div className="app__spinner" />
            <p>Loading pulse...</p>
          </div>
        </div>
      </div>
    );
  }

  // Upload view - centered upload area
  if (viewState === 'upload') {
    return (
      <div className="app app--upload">
        {renderFeaturedModal()}
        
        {/* Sticky header banner */}
        <header className="app__banner">
          <div className="app__banner-content">
            <h1 className="app__banner-title">🎙️ PulseClip</h1>
            <p className="app__banner-tagline">Word-level transcripts for audio &amp; video</p>
          </div>
          <nav className="app__banner-links" aria-label="Project links">
            <BrandSelector />
            <ThemeToggle
              mode="three-way"
              variant="ghost"
              aria-label="Toggle color theme"
            />
            <a href="https://github.com/mieweb/pulseclip" target="_blank" rel="noopener noreferrer" className="app__banner-link">
              GitHub
            </a>
            <a href="https://github.com/mieweb/pulseclip/blob/main/IMPLEMENTATION.md" target="_blank" rel="noopener noreferrer" className="app__banner-link">
              Docs
            </a>
            <a href="https://github.com/mieweb/pulseclip/issues/new" target="_blank" rel="noopener noreferrer" className="app__banner-link">
              Report Issue
            </a>
            {versionInfo && (
              <span className="app__banner-version">
                <a
                  href={versionInfo.commitUrl || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="app__banner-link app__banner-link--mono"
                  title={`Commit: ${versionInfo.commitHash}`}
                >
                  {versionInfo.commitHash.slice(0, 7)}
                </a>
                {versionInfo.commitDate && (
                  <a
                    href="https://github.com/mieweb/pulseclip/blob/main/RELEASE_NOTES.md"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="app__banner-link"
                    title="Release Notes"
                  >
                    {new Date(versionInfo.commitDate).toLocaleDateString()}
                  </a>
                )}
              </span>
            )}
          </nav>
        </header>

        <main className="app__landing">
          {/* Featured pulses - prominent */}
          {featuredPulses.length > 0 && (
            <section className="app__featured" aria-label="Featured pulses">
              <h2 className="app__featured-title">Featured Pulses</h2>
              <div className="app__featured-grid">
                {featuredPulses.map((pulse) => (
                  <a
                    key={pulse.artipodId}
                    href={`/artipod/${pulse.artipodId}`}
                    className="app__featured-card"
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/artipod/${pulse.artipodId}`);
                    }}
                  >
                    {pulse.thumbnail ? (
                      <img src={pulse.thumbnail} alt="" className="app__featured-thumb" />
                    ) : (
                      <div className="app__featured-placeholder">🎬</div>
                    )}
                    <span className="app__featured-pulse-title">{pulse.title}</span>
                  </a>
                ))}
              </div>
            </section>
          )}

          {/* Compact upload area */}
          <section className="app__upload-section">
            <h2 className="app__upload-heading">Upload Your Own</h2>
            <div className="app__upload-options">
              <div className="app__pulsecam-container">
                <PulseCamButton onError={(err) => setError(err)} />
                <p className="app__pulsecam-hint">Record directly from your phone</p>
              </div>
              <div className="app__upload-divider">
                <span>or</span>
              </div>
              <div className="app__upload-container">
                <FileUpload onFileUploaded={handleFileUploaded} disabled={false} />
              </div>
            </div>
          </section>

          {/* Features for first-time visitors */}
          <section className="app__features" aria-label="Features">
            <div className="app__feature">
              <span className="app__feature-icon">⚡</span>
              <h3 className="app__feature-title">Transcribed Instantly</h3>
              <p className="app__feature-desc">Upload and get word-level transcripts in seconds</p>
            </div>
            <div className="app__feature">
              <span className="app__feature-icon">✂️</span>
              <h3 className="app__feature-title">Word-Level Editing</h3>
              <p className="app__feature-desc">Delete fillers and dead air with a single click</p>
            </div>
            <div className="app__feature">
              <span className="app__feature-icon">📝</span>
              <h3 className="app__feature-title">Edit Like Text</h3>
              <p className="app__feature-desc">Cut and paste video as simply as a text editor</p>
            </div>
          </section>

          {error && (
            <div className="app__error">
              <strong>Error:</strong> {error}
            </div>
          )}
        </main>
      </div>
    );
  }

  // Ready/Transcribing/Viewing states - split view
  return (
    <div className="app app--split">
      {renderFeaturedModal()}
      {renderShareModal()}
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
          {artipodId && (
            <button
              className="app__share-btn"
              onClick={handleOpenShareModal}
              aria-label="Share recording"
            >
              Share
            </button>
          )}
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
