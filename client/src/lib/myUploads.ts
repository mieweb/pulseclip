/**
 * Which artipods belong to THIS browser. There are no user accounts yet, so
 * ownership is remembered locally: dropzone uploads record their artipodId on
 * completion, and PulseCam pairings record the artifactId at mint time (the
 * pairing's artifactId IS the artipod id the phone upload lands in). The
 * homepage shows featured pulses plus these — not strangers' uploads.
 */
const STORAGE_KEY = 'pulseclip_my_uploads';

export function myUploadIds(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

export function rememberMyUpload(artipodId: string): void {
  if (!artipodId) return;
  try {
    const ids = myUploadIds();
    ids.add(artipodId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage unavailable (private mode etc.) — discovery degrades gracefully
  }
}
