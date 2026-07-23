import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { EditableWord, Transcript } from '../types';
import { MediaEditor } from '../ui-staging/MediaEditor';
import { MediaPlayer, type MediaKind } from '../ui-staging/MediaPlayer';
import './SharedArtipod.scss';

interface SharedArtipodResponse {
  filename: string;
  url: string;
  transcript: Transcript | null;
  initialEditedWords?: EditableWord[];
  initialUndoStack?: EditableWord[][];
}

const VIDEO_EXTENSIONS = /\.(mp4|mov|avi|webm|mkv|m4v)$/i;

function getMediaKind(filename: string): MediaKind {
  return VIDEO_EXTENSIONS.test(filename) ? 'video' : 'audio';
}

export function SharedArtipod() {
  const { token } = useParams<{ token: string }>();
  const [sharedArtipod, setSharedArtipod] = useState<SharedArtipodResponse | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoadError(true);
      return;
    }

    fetch(`/share/${token}/data`)
      .then((response) => {
        if (!response.ok) {
          throw new Error('Shared recording not found');
        }
        return response.json() as Promise<SharedArtipodResponse>;
      })
      .then(setSharedArtipod)
      .catch(() => setLoadError(true));
  }, [token]);

  return (
    <main className="shared-artipod">
      <header className="shared-artipod__header">
        <span className="shared-artipod__brand">PulseClip</span>
      </header>
      <section className={`shared-artipod__content${sharedArtipod?.transcript ? ' shared-artipod__content--editor' : ''}`} aria-live="polite">
        {loadError ? (
          <div className="shared-artipod__message" role="alert">
            <h1>Shared recording unavailable</h1>
            <p>This link is invalid or the recording is no longer available.</p>
          </div>
        ) : !sharedArtipod ? (
          <div className="shared-artipod__message">
            <h1>Loading shared recording</h1>
          </div>
        ) : (
          <>
            <h1 className="shared-artipod__title">{sharedArtipod.filename}</h1>
            {sharedArtipod.transcript ? (
              <div className="shared-artipod__editor">
                <MediaEditor
                  src={sharedArtipod.url}
                  kind={getMediaKind(sharedArtipod.filename)}
                  transcript={sharedArtipod.transcript}
                  initialEditedWords={sharedArtipod.initialEditedWords}
                  initialUndoStack={sharedArtipod.initialUndoStack}
                />
              </div>
            ) : (
              <>
                <div className="shared-artipod__player">
                  <MediaPlayer
                    src={sharedArtipod.url}
                    kind={getMediaKind(sharedArtipod.filename)}
                    aria-label={`Shared recording: ${sharedArtipod.filename}`}
                  />
                </div>
                <p className="shared-artipod__notice">A transcript is not available for this recording yet.</p>
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}