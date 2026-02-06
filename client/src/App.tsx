import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FileUpload } from './components/FileUpload';
import { MediaPlayer } from './components/MediaPlayer';
import { TranscriptViewer } from './components/TranscriptViewer';
import type { Provider, TranscriptionResult, FeaturedPulse } from './types';
import { isDebugEnabled, toggleDebug } from './debug';
import './App.scss';

type ViewState = 'upload' | 'loading' | 'ready' | 'transcribing' | 'viewing';

function App() {
  const { artipodId: urlArtipodId } = useParams<{ artipodId: string }>();
  const navigate = useNavigate();
  
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [artipodId, setArtipodId] = useState<string>('');
  const [mediaFilename, setMediaFilename] = useState<string>('');
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptionResult, setTranscriptionResult] = useState<TranscriptionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'transcript' | 'json' | 'edited-json'>('transcript');
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
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const hasAutoTranscribed = useRef(false);

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
      if (e.code === 'Space' && mediaRef.current) {
        const target = e.target as HTMLElement;
        const isInteractiveElement = 
          target.tagName === 'INPUT' || 
          target.tagName === 'TEXTAREA' || 
          target.tagName === 'SELECT' ||
          target.tagName === 'BUTTON' ||
          target.isContentEditable;
        
        if (!isInteractiveElement) {
          e.preventDefault();
          if (mediaRef.current.paused) {
            mediaRef.current.play();
          } else {
            mediaRef.current.pause();
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
    if (!mediaRef.current || !artipodId || !apiKey) {
      if (!apiKey) setShowApiKeyModal(true);
      return false;
    }

    const video = mediaRef.current as HTMLVideoElement;
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
  const renderApiKeyModal = () => {
    if (!showApiKeyModal) return null;
    return (
      <div className="api-key-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="api-key-modal-title">
        <div className="api-key-modal">
          <h3 id="api-key-modal-title">API Key Required</h3>
          <p>Enter your API key to upload files and use transcription.</p>
          <input
            type="password"
            value={pendingApiKey}
            onChange={(e) => setPendingApiKey(e.target.value)}
            placeholder="Enter API key"
            className="api-key-modal__input"
            onKeyDown={(e) => e.key === 'Enter' && handleApiKeySubmit()}
            autoFocus
          />
          <div className="api-key-modal__actions">
            <button onClick={() => setShowApiKeyModal(false)} className="api-key-modal__cancel">
              Cancel
            </button>
            <button onClick={handleApiKeySubmit} className="api-key-modal__submit">
              Save
            </button>
          </div>
        </div>
      </div>
    );
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
        {renderApiKeyModal()}
        {renderFeaturedModal()}
        
        {/* Sticky header banner */}
        <header className="app__banner">
          <div className="app__banner-content">
            <h1 className="app__banner-title">🎙️ PulseClip</h1>
            <p className="app__banner-tagline">Word-level transcripts for audio &amp; video</p>
          </div>
          <nav className="app__banner-links" aria-label="Project links">
            <a href="https://github.com/mieweb/pulseclip" target="_blank" rel="noopener noreferrer" className="app__banner-link">
              GitHub
            </a>
            <a href="https://github.com/mieweb/pulseclip/blob/main/IMPLEMENTATION.md" target="_blank" rel="noopener noreferrer" className="app__banner-link">
              Docs
            </a>
            <a href="https://github.com/mieweb/pulseclip/issues/new" target="_blank" rel="noopener noreferrer" className="app__banner-link">
              Report Issue
            </a>
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
            <div className="app__upload-container">
              <FileUpload onFileUploaded={handleFileUploaded} disabled={false} apiKey={apiKey} onAuthError={handleAuthError} />
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
        </div>

        <div className="app__toolbar-right">
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
            <span className="app__status">Transcribing...</span>
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

      {/* Split content area */}
      <main className={`app__content${isDragging ? ' app__content--dragging' : ''}`} ref={contentRef}>
        <div 
          className="app__media-pane" 
          style={{ height: `${splitPosition}%`, maxHeight: 'none' }}
        >
          {mediaUrl && <MediaPlayer mediaUrl={mediaUrl} mediaRef={mediaRef} />}
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

          {viewState === 'viewing' && transcriptionResult && (
            <>
              <div className="app__transcript-toolbar">
                <div className="app__view-toggles">
                  <button
                    className={`app__toggle ${viewMode === 'transcript' ? 'app__toggle--active' : ''}`}
                    onClick={() => setViewMode('transcript')}
                  >
                    Transcript
                  </button>
                  <button
                    className={`app__toggle ${viewMode === 'json' ? 'app__toggle--active' : ''}`}
                    onClick={() => setViewMode('json')}
                  >
                    JSON
                  </button>
                  <button
                    className={`app__toggle ${viewMode === 'edited-json' ? 'app__toggle--active' : ''}${!hasEdits ? ' app__toggle--disabled' : ''}`}
                    onClick={() => hasEdits && setViewMode('edited-json')}
                    disabled={!hasEdits}
                  >
                    Edited JSON
                  </button>
                </div>
                <button
                  className="app__retranscribe-btn"
                  onClick={handleRetranscribe}
                  title="Re-transcribe (ignore cache)"
                  aria-label="Re-transcribe"
                >
                  🔄
                </button>
              </div>
              <TranscriptViewer
                transcript={transcriptionResult.transcript}
                mediaRef={mediaRef}
                viewMode={viewMode}
                rawData={transcriptionResult.raw}
                onHasEditsChange={setHasEdits}
                onCaptureThumbnail={handleCaptureThumbnail}
                showThumbnailCapture={isCurrentPulseFeatured}
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
