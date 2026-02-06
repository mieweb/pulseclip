import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FileUpload } from './components/FileUpload';
import { MediaPlayer } from './components/MediaPlayer';
import { TranscriptViewer } from './components/TranscriptViewer';
import type { Provider, TranscriptionResult, Demo } from './types';
import { isDebugEnabled, toggleDebug } from './debug';
import './App.scss';

type ViewState = 'upload' | 'loading' | 'ready' | 'transcribing' | 'viewing';

function App() {
  const { filename: urlFilename } = useParams<{ filename: string }>();
  const navigate = useNavigate();
  
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
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
  const [demos, setDemos] = useState<Demo[]>([]);
  const [isCurrentFileDemo, setIsCurrentFileDemo] = useState(false);
  const [showDemoModal, setShowDemoModal] = useState(false);
  const [demoTitle, setDemoTitle] = useState('');
  const [demoThumbnail, setDemoThumbnail] = useState('');
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement>(null);
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

  // Load file from URL parameter on mount
  useEffect(() => {
    if (urlFilename && !mediaUrl) {
      setLoading(true);
      fetch(`/api/file/${urlFilename}`)
        .then((res) => {
          if (!res.ok) throw new Error('File not found');
          return res.json();
        })
        .then((data) => {
          setMediaUrl(data.url);
          setMediaFilename(data.filename);
        })
        .catch((err) => {
          console.error('Failed to load file:', err);
          setError('File not found. It may have been deleted.');
          navigate('/', { replace: true });
        })
        .finally(() => setLoading(false));
    }
  }, [urlFilename, mediaUrl, navigate]);

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

  // Load demos on mount
  useEffect(() => {
    fetch('/api/demos')
      .then((res) => res.json())
      .then((data) => {
        setDemos(data.demos || []);
      })
      .catch((err) => {
        console.error('Failed to load demos:', err);
      });
  }, []);

  // Check if current file is a demo
  useEffect(() => {
    if (mediaFilename) {
      fetch(`/api/demos/${mediaFilename}`)
        .then((res) => res.json())
        .then((data) => {
          setIsCurrentFileDemo(data.isDemo);
        })
        .catch(() => {
          setIsCurrentFileDemo(false);
        });
    } else {
      setIsCurrentFileDemo(false);
    }
  }, [mediaFilename]);

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

  const handleFileUploaded = (url: string, filename: string) => {
    // Reset auto-transcribe flag for new file
    hasAutoTranscribed.current = false;
    setMediaUrl(url);
    setMediaFilename(filename);
    setTranscriptionResult(null);
    setError(null);
    setMenuOpen(false);
    // Navigate to file-specific URL
    navigate(`/file/${filename}`, { replace: true });
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

  const handleNewFile = () => {
    setMediaUrl(null);
    setMediaFilename('');
    setTranscriptionResult(null);
    setError(null);
    setMenuOpen(false);
    navigate('/', { replace: true });
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

  const handleToggleDemo = async () => {
    if (!mediaFilename || !apiKey) {
      setShowApiKeyModal(true);
      return;
    }

    if (isCurrentFileDemo) {
      // Remove demo
      try {
        const response = await fetch(`/api/demos/${mediaFilename}`, {
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
          setIsCurrentFileDemo(false);
          setDemos((prev) => prev.filter((d) => d.filename !== mediaFilename));
        }
      } catch (err) {
        console.error('Failed to remove demo:', err);
      }
    } else {
      // Show demo modal to set title/thumbnail
      const existingDemo = demos.find((d) => d.filename === mediaFilename);
      setDemoTitle(existingDemo?.title || mediaFilename);
      setDemoThumbnail(existingDemo?.thumbnail || '');
      setShowDemoModal(true);
      setMenuOpen(false);
    }
  };

  const handleDemoSubmit = async () => {
    if (!mediaFilename || !apiKey) {
      setShowApiKeyModal(true);
      return;
    }

    try {
      const response = await fetch('/api/demos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          filename: mediaFilename,
          title: demoTitle.trim() || mediaFilename,
          thumbnail: demoThumbnail.trim() || undefined,
        }),
      });

      if (response.status === 401) {
        setShowApiKeyModal(true);
        return;
      }

      if (response.ok) {
        const data = await response.json();
        setIsCurrentFileDemo(true);
        setDemos((prev) => {
          const filtered = prev.filter((d) => d.filename !== mediaFilename);
          return [...filtered, data.demo];
        });
        setShowDemoModal(false);
        setDemoTitle('');
        setDemoThumbnail('');
      }
    } catch (err) {
      console.error('Failed to save demo:', err);
    }
  };

  const handleDeleteFile = async () => {
    if (!mediaFilename) return;
    
    if (!apiKey) {
      setShowApiKeyModal(true);
      return;
    }

    // Confirm deletion
    if (!window.confirm(`Are you sure you want to delete "${mediaFilename}"? This cannot be undone.`)) {
      return;
    }

    try {
      const response = await fetch(`/api/file/${mediaFilename}`, {
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
        // Remove from demos if it was there
        setDemos((prev) => prev.filter((d) => d.filename !== mediaFilename));
        // Navigate to home
        handleNewFile();
      } else {
        const data = await response.json();
        setError(data.message || 'Failed to delete file');
      }
    } catch (err) {
      console.error('Failed to delete file:', err);
      setError('Failed to delete file');
    }
  };

  const handleCaptureThumbnail = async (timestampMs: number): Promise<boolean> => {
    if (!mediaRef.current || !mediaFilename || !apiKey) {
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
          filename: mediaFilename,
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

      // Update demo with the thumbnail URL
      const demoResponse = await fetch('/api/demos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          filename: mediaFilename,
          title: demos.find((d) => d.filename === mediaFilename)?.title || mediaFilename,
          thumbnail: url,
        }),
      });

      if (demoResponse.ok) {
        const data = await demoResponse.json();
        setDemos((prev) => {
          const filtered = prev.filter((d) => d.filename !== mediaFilename);
          return [...filtered, data.demo];
        });
        // Also update the demoThumbnail state if modal is open
        setDemoThumbnail(url);
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

  // Render Demo Modal
  const renderDemoModal = () => {
    if (!showDemoModal) return null;
    return (
      <div className="api-key-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="demo-modal-title">
        <div className="api-key-modal demo-modal">
          <h3 id="demo-modal-title">{isCurrentFileDemo ? 'Edit Demo' : 'Mark as Demo'}</h3>
          <p>Set a display title and optional thumbnail for this demo.</p>
          <label className="demo-modal__label">
            Title
            <input
              type="text"
              value={demoTitle}
              onChange={(e) => setDemoTitle(e.target.value)}
              placeholder="Enter demo title"
              className="api-key-modal__input"
              onKeyDown={(e) => e.key === 'Enter' && handleDemoSubmit()}
              autoFocus
            />
          </label>
          <label className="demo-modal__label">
            Thumbnail URL (optional)
            <input
              type="url"
              value={demoThumbnail}
              onChange={(e) => setDemoThumbnail(e.target.value)}
              placeholder="https://example.com/thumbnail.jpg"
              className="api-key-modal__input"
            />
          </label>
          {demoThumbnail && (
            <div className="demo-modal__preview">
              <img src={demoThumbnail} alt="Thumbnail preview" onError={(e) => (e.currentTarget.style.display = 'none')} />
            </div>
          )}
          <div className="api-key-modal__actions">
            <button onClick={() => setShowDemoModal(false)} className="api-key-modal__cancel">
              Cancel
            </button>
            <button onClick={handleDemoSubmit} className="api-key-modal__submit">
              Save
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Loading view - when restoring file from URL
  if (viewState === 'loading') {
    return (
      <div className="app app--upload">
        <div className="app__upload-container">
          <h1 className="app__title">🎙️ PulseClip</h1>
          <div className="app__loading">
            <div className="app__spinner" />
            <p>Loading file...</p>
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
        {renderDemoModal()}
        <div className="app__upload-container">
          <h1 className="app__title">🎙️ PulseClip</h1>
          <FileUpload onFileUploaded={handleFileUploaded} disabled={false} apiKey={apiKey} onAuthError={handleAuthError} />
          {demos.length > 0 && (
            <div className="app__demos">
              <h3 className="app__demos-title">Demo Files</h3>
              <ul className="app__demos-list">
                {demos.map((demo) => (
                  <li key={demo.filename}>
                    <a
                      href={`/file/${demo.filename}`}
                      className={`app__demo-link${demo.thumbnail ? ' app__demo-link--has-thumb' : ''}`}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(`/file/${demo.filename}`);
                      }}
                    >
                      {demo.thumbnail ? (
                        <img src={demo.thumbnail} alt="" className="app__demo-thumb" />
                      ) : (
                        <span className="app__demo-icon">🎬</span>
                      )}
                      <span className="app__demo-title">{demo.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && (
            <div className="app__error">
              <strong>Error:</strong> {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Ready/Transcribing/Viewing states - split view
  return (
    <div className="app app--split">
      {renderApiKeyModal()}
      {renderDemoModal()}
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
          <button className="app__menu-item" onClick={handleNewFile}>
            📁 New File
          </button>
          {mediaFilename && (
            <>
              {isCurrentFileDemo ? (
                <>
                  <button className="app__menu-item" onClick={() => {
                    const existingDemo = demos.find((d) => d.filename === mediaFilename);
                    setDemoTitle(existingDemo?.title || mediaFilename);
                    setDemoThumbnail(existingDemo?.thumbnail || '');
                    setShowDemoModal(true);
                    setMenuOpen(false);
                  }}>
                    ✏️ Edit Demo
                  </button>
                  <button className="app__menu-item" onClick={handleToggleDemo}>
                    ⭐ Remove Demo
                  </button>
                </>
              ) : (
                <button className="app__menu-item" onClick={handleToggleDemo}>
                  ⭐ Mark as Demo
                </button>
              )}
              <button className="app__menu-item app__menu-item--danger" onClick={handleDeleteFile}>
                🗑️ Delete File
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
      <main className="app__content">
        <div className="app__media-pane">
          {mediaUrl && <MediaPlayer mediaUrl={mediaUrl} mediaRef={mediaRef} />}
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
                showThumbnailCapture={isCurrentFileDemo}
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
