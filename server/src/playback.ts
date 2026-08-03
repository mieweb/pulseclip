import { execFile } from 'child_process';
import { existsSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';
import { runHeavyJob } from './queue.js';

/**
 * Build a web-playable copy of an upload, alongside the original.
 *
 * Phone captures are recorded for storage efficiency, not for delivery, and
 * three separate things make them unplayable in a browser:
 *
 *   codec      HEVC. Android Chrome has no decoder at all — it is not slow,
 *              it simply cannot. (Patent licensing, not a technical limit.)
 *   moov atom  written last, because a camera does not know the frame offsets
 *              until recording stops. A player cannot draw a single frame
 *              before it reads that index, so it range-requests the tail of a
 *              half-gigabyte file, or gives up.
 *   bitrate    ~28 Mbps is 3.5 MB per second of playback. Even a device that
 *              can decode it stalls on anything but good wifi.
 *
 * One transcode fixes all three: H.264 at 1080p with +faststart. Measured on
 * the dev box against a real 166s 4K capture — 124s to encode, 553 MB down to
 * 16 MB. The original stays untouched and remains what edit and export read,
 * so this is a delivery copy only (a proxy workflow, in editing terms).
 */
export const PLAYBACK_PROXY = 'playback.mp4';

export function ensurePlaybackProxy(artipodPath: string, mediaFile: string): void {
  const src = join(artipodPath, mediaFile);
  const out = join(artipodPath, PLAYBACK_PROXY);
  if (mediaFile === PLAYBACK_PROXY || existsSync(out) || !existsSync(src)) return;

  // Probe first — it is instant, and most browser uploads are already H.264 at
  // a sane bitrate with the index up front. Re-encoding those would burn two
  // minutes of the shared queue to produce a worse copy of a working file.
  execFile(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=bit_rate', '-show_entries',
     'stream=codec_type,codec_name', '-of', 'json', src],
    (probeErr, stdout) => {
      if (probeErr) return; // not media, or unreadable — nothing to proxy
      let info: any = {};
      try { info = JSON.parse(stdout || '{}'); } catch { return; }

      const video = (info.streams || []).find((s: any) => s.codec_type === 'video');
      if (!video) return; // audio-only uploads play fine as they are
      const bitrate = Number(info.format?.bit_rate) || 0;
      const needsProxy = video.codec_name !== 'h264' || bitrate > 8_000_000;
      if (!needsProxy) return;

      // Shares the single heavy-job slot with renders and Whisper. Two ffmpeg
      // processes at once is what OOM-killed this box before, and a 4K decode
      // is exactly the kind of neighbour that would do it again.
      runHeavyJob(`playback proxy ${mediaFile}`, () =>
        new Promise<void>((resolve) => {
          const tmp = `${out}.partial.mp4`;
          execFile(
            'ffmpeg',
            ['-y', '-i', src,
             '-vf', 'scale=-2:1080',
             '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
             '-maxrate', '3M', '-bufsize', '6M',
             '-c:a', 'aac', '-b:a', '128k',
             '-movflags', '+faststart', tmp],
            { maxBuffer: 1024 * 1024 },
            (err) => {
              if (err) {
                try { unlinkSync(tmp); } catch { /* nothing to clean */ }
                console.warn(`[PROXY] ${mediaFile}: transcode failed, playback falls back to the original`);
              } else {
                // Rename only on success, so a crashed encode never leaves a
                // truncated file that the player would prefer over the original.
                renameSync(tmp, out);
                console.log(`[PROXY] ${mediaFile} -> ${PLAYBACK_PROXY}`);
              }
              resolve();
            }
          );
        })
      ).catch(() => {});
    }
  );
}
