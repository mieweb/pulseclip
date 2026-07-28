import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import {
  createPulseVaultCore,
  createLocalStorage,
  createMp4Sniffer,
  createCapabilityAuthorize,
  issueCapabilityToken,
  buildUploadLink,
} from '@mieweb/pulsevault/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ARTIPODS_DIR = join(__dirname, '../artipods');
const VAULT_DATA_DIR = join(__dirname, '../vault-data');

// Capability-token settings. With PULSEVAULT_SECRET unset the lane is open
// (matching the legacy TUS router); set it to require a signed, expiring
// per-artifact token minted at pairing time.
const ISSUER = 'pulseclip';
const KEY_ID = 'v1';
const TOKEN_TTL_SECONDS = 30 * 60;
const secret = process.env.PULSEVAULT_SECRET || '';

const storage = createLocalStorage({ workspaceDir: VAULT_DATA_DIR });

/** Sidecar shape from pulsevault's documented stable filesystem contract */
interface VaultSidecar {
  ext?: string;
  filename?: string;
  kind?: string;
  relatedTo?: string;
}

function readSidecar(artifactId: string): VaultSidecar | null {
  try {
    return JSON.parse(
      readFileSync(join(storage.workspaceRoot, '.pulsevault', `${artifactId}.json`), 'utf-8')
    );
  } catch {
    return null;
  }
}

/**
 * Bridge a finished pulsevault upload into PulseClip's artipod layout, the
 * same shape the legacy TUS lane and the browser dropzone produce. The
 * artipod id IS the artifactId minted at pairing time. Captions ride along
 * into the video's artipod via their relatedTo anchor; the beat manifest and
 * thumbnail stay in the vault until something consumes them.
 */
async function handleUploadComplete(
  _req: unknown,
  ctx: { artifactId: string; kind: string; size: number }
): Promise<void> {
  const sidecar = readSidecar(ctx.artifactId);

  if (ctx.kind === 'video') {
    const ext = sidecar?.ext ?? '.mp4';
    const src = join(storage.workspaceRoot, 'video', `${ctx.artifactId}${ext}`);
    const artipodPath = join(ARTIPODS_DIR, ctx.artifactId);
    mkdirSync(artipodPath, { recursive: true });
    const filename = basename(sidecar?.filename || `video${ext}`);
    copyFileSync(src, join(artipodPath, filename));
    console.log(
      `[VAULT] video ${ctx.artifactId} -> artipod ${ctx.artifactId} (${filename}, ${ctx.size} bytes)`
    );
    return;
  }

  if (ctx.kind === 'captions' && sidecar?.relatedTo) {
    const artipodPath = join(ARTIPODS_DIR, sidecar.relatedTo);
    if (!existsSync(artipodPath)) return;
    const ext = sidecar.ext ?? '.vtt';
    const src = join(storage.workspaceRoot, 'captions', `${ctx.artifactId}${ext}`);
    copyFileSync(src, join(artipodPath, basename(sidecar.filename || `captions${ext}`)));
    console.log(`[VAULT] captions ${ctx.artifactId} -> artipod ${sidecar.relatedTo}`);
    return;
  }

  if (ctx.kind === 'thumbnail' && sidecar?.relatedTo) {
    const artipodPath = join(ARTIPODS_DIR, sidecar.relatedTo);
    if (!existsSync(artipodPath)) return;
    const ext = sidecar.ext ?? '.jpg';
    const src = join(storage.workspaceRoot, 'thumbnail', `${ctx.artifactId}${ext}`);
    // Normalize to the two names the app knows (media detection excludes
    // them; the artipod route and OG tags look them up)
    const dest = ext === '.png' ? 'thumbnail.png' : 'thumbnail.jpg';
    copyFileSync(src, join(artipodPath, dest));
    console.log(`[VAULT] thumbnail ${ctx.artifactId} -> artipod ${sidecar.relatedTo}/${dest}`);
  }
}

const sniffVideo = createMp4Sniffer(storage);

export const pulseVault = createPulseVaultCore({
  basePath: '/pulsevault',
  // Express's app.use('/pulsevault', ...) strips the mount prefix from
  // req.url before the handler runs; basePath still shapes the tus Location
  stripBasePath: false,
  storage,
  maxUploadSize: 2 * 1024 * 1024 * 1024, // 2 GiB
  // PulseClip is one-video-per-artipod: the app pre-merges its clips and
  // uploads one video (+ captions, beat manifest, thumbnail)
  uploadUnit: 'merged',
  allowedExtensions: {
    video: ['.mp4'],
    project: ['.pulse', '.zip'],
    captions: ['.vtt'],
    thumbnail: ['.jpg', '.jpeg', '.png'],
  },
  ...(secret
    ? {
        authorize: createCapabilityAuthorize((kid: string) => (kid === KEY_ID ? secret : null), {
          issuer: ISSUER,
        }),
      }
    : {}),
  validatePayload: async (req, ctx) => {
    if (ctx.kind === 'video') return sniffVideo(req, ctx);
  },
  onUploadComplete: handleUploadComplete,
});

export interface PulseCamPairing {
  deeplink: string;
  serverUrl: string;
  token: string;
  artifactId: string;
}

/**
 * Mint one pairing session for the PulseCam app: a fresh artifactId, a
 * capability token when the lane is locked, and the pulsecam:// deep link
 * pointing the app at this server's /pulsevault mount.
 */
export function mintPulseCamPairing(serverUrl: string): PulseCamPairing {
  const artifactId = randomUUID();
  const token = secret
    ? issueCapabilityToken(artifactId, secret, {
        keyId: KEY_ID,
        issuer: ISSUER,
        expirySeconds: TOKEN_TTL_SECONDS,
      })
    : '';
  const deeplink = buildUploadLink({
    server: `${serverUrl}/pulsevault`,
    artifactId,
    ...(token ? { token } : {}),
    uploadUnit: 'merged',
  });
  return { deeplink, serverUrl, token, artifactId };
}
