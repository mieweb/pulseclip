import { useState, type FC, type RefObject } from 'react';
import './MediaPlayer.scss';

interface MediaPlayerProps {
  mediaUrl: string;
  mediaRef: RefObject<HTMLAudioElement | HTMLVideoElement>;
}

export const MediaPlayer: FC<MediaPlayerProps> = ({ mediaUrl, mediaRef }) => {
  const [error, setError] = useState<string | null>(null);
  
  // Detect if it's audio or video based on file extension
  const isVideo = /\.(mp4|mov|avi|webm|mkv)$/i.test(mediaUrl);

  const handleError = () => {
    setError('Unable to load media. The server may be unavailable.');
  };

  const handleCanPlay = () => {
    setError(null);
  };

  if (error) {
    return (
      <div className="media-player">
        <div className="media-player__error">
          <span className="media-player__error-icon">⚠️</span>
          <p className="media-player__error-message">{error}</p>
          <button 
            className="media-player__retry-btn"
            onClick={() => {
              setError(null);
              // Force reload by updating the src
              if (mediaRef.current) {
                mediaRef.current.load();
              }
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="media-player">
      <div className="media-player__container">
        {isVideo ? (
          <video
            ref={mediaRef as RefObject<HTMLVideoElement>}
            src={mediaUrl}
            controls
            playsInline
            className="media-player__video"
            onError={handleError}
            onCanPlay={handleCanPlay}
          />
        ) : (
          <audio
            ref={mediaRef as RefObject<HTMLAudioElement>}
            src={mediaUrl}
            controls
            className="media-player__audio"
            onError={handleError}
            onCanPlay={handleCanPlay}
          />
        )}
      </div>
    </div>
  );
};
