import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FileUpload } from './components/FileUpload';
import { MediaPlayer } from './components/MediaPlayer';
import { TranscriptViewer } from './components/TranscriptViewer';
import type { Provider, TranscriptionResult } from './types';
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
        <div className="app__upload-container">
          <h1 className="app__title">🎙️ PulseClip</h1>
          <FileUpload onFileUploaded={handleFileUploaded} disabled={false} apiKey={apiKey} onAuthError={handleAuthError} />
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
                >
                  🔄 Re-transcribe
                </button>
              </div>
              <TranscriptViewer
                transcript={transcriptionResult.transcript}
                mediaRef={mediaRef}
                viewMode={viewMode}
                rawData={transcriptionResult.raw}
                onHasEditsChange={setHasEdits}
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
