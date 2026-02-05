import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FileUpload } from './components/FileUpload';
import { MediaPlayer } from './components/MediaPlayer';
import { TranscriptViewer } from './components/TranscriptViewer';
import type { Provider, TranscriptionResult } from './types';
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
  const [showRaw, setShowRaw] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
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
          },
        }),
      });

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

  // Loading view - when restoring file from URL
  if (viewState === 'loading') {
    return (
      <div className="app app--upload">
        <div className="app__upload-container">
          <h1 className="app__title">🎙️ Voice Transcription</h1>
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
        <div className="app__upload-container">
          <h1 className="app__title">🎙️ Voice Transcription</h1>
          <FileUpload onFileUploaded={handleFileUploaded} disabled={false} />
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
                    className={`app__toggle ${!showRaw ? 'app__toggle--active' : ''}`}
                    onClick={() => setShowRaw(false)}
                  >
                    Transcript
                  </button>
                  <button
                    className={`app__toggle ${showRaw ? 'app__toggle--active' : ''}`}
                    onClick={() => setShowRaw(true)}
                  >
                    JSON
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
                showRaw={showRaw}
                rawData={transcriptionResult.raw}
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
