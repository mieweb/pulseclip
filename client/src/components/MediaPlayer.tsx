import type { FC, RefObject } from 'react';
import './MediaPlayer.scss';

interface MediaPlayerProps {
  mediaUrl: string;
  mediaRef: RefObject<HTMLAudioElement | HTMLVideoElement>;
}

export const MediaPlayer: FC<MediaPlayerProps> = ({ mediaUrl, mediaRef }) => {
  // Detect if it's audio or video based on file extension
  const isVideo = /\.(mp4|mov|avi|webm|mkv)$/i.test(mediaUrl);

  return (
    <div className="media-player">
      <div className="media-player__container">
        {isVideo ? (
          <video
            ref={mediaRef as RefObject<HTMLVideoElement>}
            src={mediaUrl}
            controls
            className="media-player__video"
          />
        ) : (
          <audio
            ref={mediaRef as RefObject<HTMLAudioElement>}
            src={mediaUrl}
            controls
            className="media-player__audio"
          />
        )}
      </div>
    </div>
  );
};
