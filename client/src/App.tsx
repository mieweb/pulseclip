import { useState, useRef, useEffect } from 'react';
import { FileUpload } from './components/FileUpload';
import { MediaPlayer } from './components/MediaPlayer';
import { TranscriptViewer } from './components/TranscriptViewer';
import type { Provider, TranscriptionResult } from './types';
import './App.scss';

function App() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptionResult, setTranscriptionResult] = useState<TranscriptionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement>(null);

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

  const handleFileUploaded = (url: string, filename: string) => {
    setMediaUrl(url);
    setTranscriptionResult(null);
    setError(null);
    console.log('File uploaded:', filename);
  };

  const handleTranscribe = async () => {
    if (!mediaUrl || !selectedProvider) return;

    setTranscribing(true);
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

  return (
    <div className="app">
      <header className="app__header">
        <h1>🎙️ Voice Transcription POC</h1>
        <p>Upload audio or video files and get interactive transcripts</p>
      </header>

      <main className="app__main">
        <section className="app__upload-section">
          <FileUpload
            onFileUploaded={handleFileUploaded}
            disabled={transcribing}
          />

          {mediaUrl && (
            <div className="app__controls">
              <div className="app__provider-select">
                <label htmlFor="provider">Transcription Provider:</label>
                <select
                  id="provider"
                  value={selectedProvider}
                  onChange={(e) => setSelectedProvider(e.target.value)}
                  disabled={transcribing || providers.length === 0}
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.displayName}
                    </option>
                  ))}
                </select>
              </div>

              <button
                className="app__transcribe-btn"
                onClick={handleTranscribe}
                disabled={transcribing || !selectedProvider}
              >
                {transcribing ? 'Transcribing...' : 'Transcribe'}
              </button>
            </div>
          )}

          {error && (
            <div className="app__error">
              <strong>Error:</strong> {error}
            </div>
          )}
        </section>

        {mediaUrl && (
          <section className="app__media-section">
            <MediaPlayer mediaUrl={mediaUrl} mediaRef={mediaRef} />
          </section>
        )}

        {transcriptionResult && (
          <section className="app__transcript-section">
            <div className="app__transcript-controls">
              <button
                className={`app__view-toggle ${!showRaw ? 'active' : ''}`}
                onClick={() => setShowRaw(false)}
              >
                Transcript View
              </button>
              <button
                className={`app__view-toggle ${showRaw ? 'active' : ''}`}
                onClick={() => setShowRaw(true)}
              >
                Raw JSON
              </button>
            </div>

            <TranscriptViewer
              transcript={transcriptionResult.transcript}
              mediaRef={mediaRef}
              showRaw={showRaw}
              rawData={transcriptionResult.raw}
            />
          </section>
        )}
      </main>

      <footer className="app__footer">
        <p>
          POC demonstrating provider-agnostic transcription with word-level timestamps
        </p>
      </footer>
    </div>
  );
}

export default App;
