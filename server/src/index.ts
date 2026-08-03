import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { randomUUID, createHash } from 'crypto';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, statSync, unlinkSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, renameSync } from 'fs';
import dotenv from 'dotenv';
import { initializeProviders } from './providers/registry.js';
import { getCachedTranscription, cacheTranscription, getCacheStats, clearCache, removeCacheForFile } from './cache.js';
import { getFeatured, addFeatured, removeFeatured, isFeatured } from './featured.js';
import { createTusRouter, cleanupStaleUploads, findArtipodByChecksum, registerChecksum } from './tus.js';
import { buildExportPlan, buildSrt, renderExport, canBurnSubtitles, EXPORT_FILENAMES } from './export.js';
import { generateAgentEdit, buildBaseline, resolveAgentConfig, AgentNotConfiguredError, type AgentOp } from './agent.js';
import { pulseVault, mintPulseCamPairing } from './pulsevault.js';
import { runHeavyJob } from './queue.js';
import { PLAYBACK_PROXY, ensurePlaybackProxy } from './playback.js';

// Load environment variables
dotenv.config();

// --- Async transcription job store ---
interface TranscriptionJob {
  id: string;
  status: 'processing' | 'completed' | 'error';
  result?: any;
  error?: string;
  createdAt: number;
}
const transcriptionJobs = new Map<string, TranscriptionJob>();
// File size threshold (in bytes) above which transcription runs async (100MB)
const ASYNC_TRANSCRIPTION_THRESHOLD = 100 * 1024 * 1024;

// --- Async export (render) job store ---
interface ExportJob {
  id: string;
  status: 'processing' | 'completed' | 'error';
  downloadUrl?: string;
  filename?: string;
  durationMs?: number;
  srtUrl?: string;
  error?: string;
  createdAt: number;
}
const exportJobs = new Map<string, ExportJob>();

// --- Async editorial-agent (LLM proposal) job store ---
interface AgentJob {
  id: string;
  status: 'processing' | 'completed' | 'error';
  result?: {
    summary: string;
    ops: AgentOp[];
    deletedCount: number;
    contentCount: number;
    silenceCount: number;
    durationMs: number;
    targetSeconds: number | null;
    rounds: number;
    provider: string;
    model: string;
  };
  error?: string;
  /** True when the failure is "no LLM configured" (a 503, not a 500) */
  notConfigured?: boolean;
  createdAt: number;
}
const agentJobs = new Map<string, AgentJob>();

/**
 * artipodId -> jobId of the agent run currently holding it. The agent is the one
 * endpoint that does read-modify-write on edits.json across an await, so it is
 * the one that can lose a checkpoint to a concurrent caller. Released in a
 * finally, so a thrown run frees the pulse rather than wedging it forever.
 */
const agentLocks = new Map<string, string>();

/**
 * How many agent checkpoints an artipod keeps. Each holds a full copy of the
 * edit list, so this is a disk/history tradeoff — ten is a couple of MB on a
 * long video and more iterations than anyone reviews in one sitting. Index 0
 * (the original) is exempt from eviction.
 */
const MAX_CHECKPOINTS = 10;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Initialize provider registry
const providerRegistry = initializeProviders();

// Secret key for ADMIN endpoints only (curation + destructive ops: feature,
// delete, cache clear). Participation routes — upload, edit, export, agent —
// are open: visitors must be able to use the product without a key.
const secretKey = process.env.SECRET_KEY;

// Auth middleware for admin endpoints
const requireAuth: express.RequestHandler = (req, res, next) => {
  if (!secretKey) {
    // No secret key configured, allow all requests
    return next();
  }

  const providedKey = req.headers['x-api-key'] as string;
  if (!providedKey || providedKey !== secretKey) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Valid API key required' });
  }
  next();
};

// Configure multer for file uploads into artipod folders
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    // Create a new artipod folder with UUID for each upload
    const artipodId = randomUUID();
    const artipodPath = join(__dirname, '../artipods', artipodId);
    mkdirSync(artipodPath, { recursive: true });
    // Store artipodId on the request for later use
    (_req as any).artipodId = artipodId;
    cb(null, artipodPath);
  },
  filename: (_req, file, cb) => {
    // Keep original filename inside the artipod folder
    cb(null, file.originalname);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: Infinity,
  },
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increased limit for base64 image uploads

// TUS resumable upload router (must be before body parsing affects routes)
app.use('/uploads', createTusRouter());

// PulseVault resumable-upload lane (@mieweb/pulsevault/core) — the PulseCam
// pairing target. The legacy hand-rolled TUS router above stays mounted
// until phone-side compatibility is confirmed in the field, then it goes.
app.use('/pulsevault', (req, res, next) => {
  pulseVault.handler(req, res, next).catch(next);
});

// Run cleanup of stale TUS uploads on startup and every hour
cleanupStaleUploads();
setInterval(cleanupStaleUploads, 60 * 60 * 1000);

// Serve artipod files
app.use('/artipods', express.static(join(__dirname, '../artipods')));

// In production, serve the client build
const clientDistPath = join(__dirname, '../../client/dist');
if (existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
}

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// About/version info
app.get('/api/about', async (_req, res) => {
  try {
    // Try to get git commit info
    const { execSync } = await import('child_process');
    const commitHash = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const commitDate = execSync('git log -1 --format=%ci', { encoding: 'utf-8' }).trim();
    const commitUrl = `https://github.com/mieweb/pulseclip/commit/${commitHash}`;
    
    res.json({
      name: 'PulseClip',
      git: {
        commitHash,
        commitDate,
        commitUrl,
      },
      agent: { configured: isAgentConfigured() },
    });
  } catch (error) {
    // Fallback if git not available
    res.json({
      name: 'PulseClip',
      git: null,
      agent: { configured: isAgentConfigured() },
    });
  }
});

// Grab a poster frame for artipods that arrived without one (browser
// uploads have no client-side capture). Async and best-effort: failures
// (audio files, corrupt media) just leave the artipod imageless.
function ensureThumbnail(artipodPath: string, mediaFile: string): void {
  if (
    existsSync(join(artipodPath, 'thumbnail.png')) ||
    existsSync(join(artipodPath, 'thumbnail.jpg'))
  ) {
    return;
  }
  execFile(
    'ffmpeg',
    ['-y', '-ss', '1', '-i', join(artipodPath, mediaFile), '-frames:v', '1', '-vf', 'scale=480:-2', join(artipodPath, 'thumbnail.jpg')],
    (err) => {
      if (err) console.warn(`[THUMB] no poster for ${mediaFile}: frame grab failed`);
    }
  );
}

// Whether the editorial agent has an LLM to talk to — clients hide the
// AI-edit button when it doesn't (a dead button on unconfigured hosts)
function isAgentConfigured(): boolean {
  try {
    resolveAgentConfig();
    return true;
  } catch {
    return false;
  }
}

// Display title for an artipod that isn't featured: PulseCam uploads carry
// the draft's name (written as a .title dot-file by the pulsevault bridge)
function readArtipodTitle(artipodPath: string): string | undefined {
  try {
    const title = readFileSync(join(artipodPath, '.title'), 'utf-8').trim();
    return title || undefined;
  } catch {
    return undefined;
  }
}

// List every artipod that holds playable media (newest first). Public and
// read-only, like /api/featured — this is how uploads that nobody curated
// (e.g. PulseCam arrivals) become discoverable in the client.
app.get('/api/artipods', (_req, res) => {
  const artipodsDir = join(__dirname, '../artipods');
  if (!existsSync(artipodsDir)) {
    return res.json({ artipods: [] });
  }
  const featuredList = getFeatured();
  const artipods = readdirSync(artipodsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const id = entry.name;
      const artipodPath = join(artipodsDir, id);
      const mediaFile = findMediaInArtipod(artipodPath);
      if (!mediaFile) return [];
      let stats;
      try {
        stats = statSync(join(artipodPath, mediaFile));
      } catch {
        return [];
      }
      const thumbnailFile = ['thumbnail.png', 'thumbnail.jpg'].find((f) =>
        existsSync(join(artipodPath, f))
      );
      const featured = featuredList.find((f) => f.artipodId === id);
      return [
        {
          artipodId: id,
          filename: mediaFile,
          url: `/artipods/${id}/${mediaFile}`,
          size: stats.size,
          uploadedAt: stats.mtime.toISOString(),
          thumbnail:
            featured?.thumbnail ??
            (thumbnailFile ? `/artipods/${id}/${thumbnailFile}` : undefined),
          featured: Boolean(featured),
          title: featured?.title ?? readArtipodTitle(artipodPath),
        },
      ];
    })
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  res.json({ artipods });
});

// Get available providers
app.get('/api/providers', (_req, res) => {
  const providers = providerRegistry.list();
  res.json({ providers });
});

// Generate PulseCam deep link for mobile app integration. Each call mints one
// pairing session against the /pulsevault lane (fresh artifactId + capability
// token when PULSEVAULT_SECRET is set).
app.get('/api/pulsecam/deeplink', (req, res) => {
  // Determine the server URL from request headers
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const serverUrl = `${protocol}://${host}`;

  try {
    const pairing = mintPulseCamPairing(serverUrl);
    res.json({
      ...pairing,
      appStoreLinks: {
        ios: 'https://apps.apple.com/us/app/pulse-cam/id6748621024',
        android: 'https://play.google.com/store/apps/details?id=com.mieweb.pulse',
      },
    });
  } catch (error) {
    // buildUploadLink refuses plaintext public origins by design
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to mint pairing link',
    });
  }
});

// Upload pulse (protected) - creates an artipod folder with UUID
// Includes duplicate detection based on file checksum
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const artipodId = (req as any).artipodId;
  const localPath = join(__dirname, '../artipods', artipodId, req.file.originalname);
  
  // Calculate checksum for duplicate detection
  const fileContent = readFileSync(localPath);
  const checksum = createHash('sha256').update(fileContent).digest('hex');
  
  // Check for existing file with same checksum
  const existing = findArtipodByChecksum(checksum);
  if (existing) {
    // Delete the newly created artipod folder since we already have this file
    const newArtipodPath = join(__dirname, '../artipods', artipodId);
    try {
      rmSync(newArtipodPath, { recursive: true, force: true });
    } catch (e) {
      console.error('Failed to cleanup duplicate upload:', e);
    }
    
    const fileUrl = `/artipods/${existing.artipodId}/${existing.filename}`;
    return res.json({
      success: true,
      artipodId: existing.artipodId,
      filename: existing.filename,
      url: fileUrl,
      localPath: join(__dirname, '../artipods', existing.artipodId, existing.filename),
      size: req.file.size,
      mimetype: req.file.mimetype,
      duplicate: true,
    });
  }
  
  // Register the new checksum
  registerChecksum(checksum, artipodId, req.file.originalname);

  // Best-effort poster so the upload gets a card image (fire-and-forget;
  // audio-only files simply fail the frame grab and stay imageless)
  ensureThumbnail(join(__dirname, '../artipods', artipodId), req.file.originalname);
  ensurePlaybackProxy(join(__dirname, '../artipods', artipodId), req.file.originalname);

  const fileUrl = `/artipods/${artipodId}/${req.file.originalname}`;

  res.json({
    success: true,
    artipodId,
    filename: req.file.originalname,
    url: fileUrl,
    localPath,
    size: req.file.size,
    mimetype: req.file.mimetype,
    duplicate: false,
  });
});

// Transcribe with selected provider (auth required only for non-cached requests)
app.post('/api/transcribe', async (req, res) => {
  try {
    const { mediaUrl, providerId, options, skipCache } = req.body;

    if (!mediaUrl) {
      return res.status(400).json({ error: 'mediaUrl is required' });
    }

    if (!providerId) {
      return res.status(400).json({ error: 'providerId is required' });
    }

    const provider = providerRegistry.get(providerId);
    if (!provider) {
      return res.status(400).json({
        error: `Provider '${providerId}' not found`,
        availableProviders: providerRegistry.list(),
      });
    }

    // Extract artipodId and filename from URL: /artipods/{artipodId}/{filename}
    const urlParts = mediaUrl.split('/');
    const filename = urlParts.pop() || '';
    const artipodId = urlParts.pop() || '';
    const localPath = join(__dirname, '../artipods', artipodId, filename);

    // Check cache first (unless skipCache is true) - no auth required for cached results
    if (!skipCache) {
      const cachedResult = await getCachedTranscription(localPath, providerId);
      if (cachedResult) {
        console.log(`Returning cached transcription for ${filename}`);
        return res.json({
          success: true,
          cached: true,
          provider: {
            id: provider.id,
            displayName: provider.displayName,
          },
          transcript: cachedResult.normalized,
          raw: cachedResult.raw,
        });
      }
    } else {
      console.log(`Skipping cache for ${filename} (re-transcribe requested)`);
    }

    // Transcription is open: the default provider is local Whisper (free,
    // on-box). AssemblyAI is the one paid path — visitors picking it spend
    // this deployment's key, which is acceptable as a deliberate opt-in.

    // Check file size to determine sync vs async transcription
    // (providers marked alwaysAsync are too slow to hold an HTTP request open)
    const fileSize = existsSync(localPath) ? statSync(localPath).size : 0;

    if (fileSize > ASYNC_TRANSCRIPTION_THRESHOLD || provider.alwaysAsync) {
      // Large file: run transcription asynchronously
      const jobId = randomUUID();
      transcriptionJobs.set(jobId, { id: jobId, status: 'processing', createdAt: Date.now() });

      console.log(`Large file (${(fileSize / 1024 / 1024).toFixed(1)}MB) - starting async transcription job ${jobId}`);
      console.log(`Using local file: ${localPath}`);

      // Fire and forget - transcription runs in background, queued behind
      // any other heavy job so concurrent uploads can't exhaust memory
      runHeavyJob(`transcribe ${providerId}`, () => provider.transcribe(localPath, options)).then(async (result) => {
        console.log(`Async transcription complete for job ${jobId}. Words: ${result.normalized.words.length}`);
        await cacheTranscription(localPath, providerId, result);
        transcriptionJobs.set(jobId, {
          id: jobId,
          status: 'completed',
          createdAt: transcriptionJobs.get(jobId)!.createdAt,
          result: {
            success: true,
            cached: false,
            provider: { id: provider.id, displayName: provider.displayName },
            transcript: result.normalized,
            raw: result.raw,
          },
        });
      }).catch((err) => {
        console.error(`Async transcription failed for job ${jobId}:`, err);
        transcriptionJobs.set(jobId, {
          id: jobId,
          status: 'error',
          createdAt: transcriptionJobs.get(jobId)!.createdAt,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      });

      return res.status(202).json({
        success: true,
        status: 'processing',
        jobId,
        message: 'This file is large and may take several minutes to transcribe. You can check back shortly.',
      });
    }

    console.log(`Starting transcription with ${provider.displayName}...`);
    console.log(`Using local file: ${localPath}`);
    const result = await runHeavyJob(`transcribe ${providerId}`, () =>
      provider.transcribe(localPath, options)
    );
    console.log(`Transcription complete. Words: ${result.normalized.words.length}`);

    // Cache the result
    await cacheTranscription(localPath, providerId, result);

    res.json({
      success: true,
      cached: false,
      provider: {
        id: provider.id,
        displayName: provider.displayName,
      },
      transcript: result.normalized,
      raw: result.raw,
    });
  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({
      error: 'Transcription failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Poll for async transcription job status
app.get('/api/transcribe/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = transcriptionJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status === 'completed') {
    // Clean up after delivering result
    transcriptionJobs.delete(jobId);
    return res.json(job.result);
  }

  if (job.status === 'error') {
    transcriptionJobs.delete(jobId);
    return res.status(500).json({ error: 'Transcription failed', message: job.error });
  }

  // Still processing
  res.json({ status: 'processing', jobId });
});

// Helper to find media file in artipod folder
function findMediaInArtipod(artipodPath: string): string | null {
  if (!existsSync(artipodPath)) return null;
  const files = readdirSync(artipodPath);
  // Find the first media file (exclude known asset files, rendered exports,
  // and caption sidecars — PulseCam merged uploads place a .vtt next to the
  // video)
  const assetFiles = ['thumbnail.png', 'thumbnail.jpg', 'transcript.json', 'beats.json', 'edits.json', PLAYBACK_PROXY, ...EXPORT_FILENAMES];
  const mediaFile = files.find(
    f =>
      !assetFiles.includes(f) &&
      !f.startsWith('.') &&
      !f.endsWith('.vtt') &&
      !f.endsWith('.srt')
  );
  return mediaFile || null;
}

// Helper to get artipod metadata for Open Graph tags
interface ArtipodMetadata {
  title: string;
  description: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  mediaUrl: string | null;
}

function getArtipodMetadata(artipodId: string, baseUrl: string): ArtipodMetadata | null {
  const artipodPath = join(__dirname, '../artipods', artipodId);
  
  if (!existsSync(artipodPath)) return null;
  
  // Get title from featured list, fallback to artipodId
  const featuredList = getFeatured();
  const featured = featuredList.find(f => f.artipodId === artipodId);
  const title = featured?.title || 'PulseClip Video';
  
  // Get thumbnail URL
  const thumbnailPng = join(artipodPath, 'thumbnail.png');
  const thumbnailJpg = join(artipodPath, 'thumbnail.jpg');
  let thumbnailUrl: string | null = null;
  if (existsSync(thumbnailPng)) {
    thumbnailUrl = `${baseUrl}/artipods/${artipodId}/thumbnail.png`;
  } else if (existsSync(thumbnailJpg)) {
    thumbnailUrl = `${baseUrl}/artipods/${artipodId}/thumbnail.jpg`;
  }
  
  // Get duration from edits.json (edited transcript time - sum of non-deleted words)
  let durationSeconds: number | null = null;
  const editsPath = join(artipodPath, 'edits.json');
  if (existsSync(editsPath)) {
    try {
      const editsData = JSON.parse(readFileSync(editsPath, 'utf-8'));
      if (editsData.editedWords && editsData.editedWords.length > 0) {
        // Calculate total duration of non-deleted words
        let totalMs = 0;
        for (const editedWord of editsData.editedWords) {
          if (!editedWord.deleted && editedWord.word?.startMs !== undefined && editedWord.word?.endMs !== undefined) {
            totalMs += editedWord.word.endMs - editedWord.word.startMs;
          }
        }
        if (totalMs > 0) {
          durationSeconds = Math.ceil(totalMs / 1000);
        }
      }
    } catch {
      // Ignore parsing errors
    }
  }
  
  // Get media URL
  const mediaFile = findMediaInArtipod(artipodPath);
  const mediaUrl = mediaFile ? `${baseUrl}/artipods/${artipodId}/${mediaFile}` : null;
  
  // Format duration as X.X mins and append to title
  let displayTitle = title;
  let description = 'Watch and edit video transcripts with PulseClip';
  if (durationSeconds !== null) {
    const mins = (durationSeconds / 60).toFixed(1);
    const durationStr = `${mins} mins`;
    displayTitle = `${title} (${durationStr})`;
    description = `Duration: ${durationStr}`;
  }
  
  return {
    title: displayTitle,
    description,
    thumbnailUrl,
    durationSeconds,
    mediaUrl,
  };
}

// Generate HTML with Open Graph meta tags for social sharing previews
function generateOgHtml(metadata: ArtipodMetadata, artipodId: string, baseUrl: string): string {
  const canonicalUrl = `${baseUrl}/artipod/${artipodId}`;
  
  // Read the base index.html template
  const indexPath = join(clientDistPath, 'index.html');
  let html = existsSync(indexPath) 
    ? readFileSync(indexPath, 'utf-8')
    : `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><title>PulseClip</title></head><body><div id="root"></div></body></html>`;
  
  // Build OG meta tags
  const ogTags = [
    `<meta property="og:title" content="${escapeHtml(metadata.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(metadata.description)}" />`,
    `<meta property="og:type" content="video.other" />`,
    `<meta property="og:url" content="${canonicalUrl}" />`,
    `<meta property="og:site_name" content="PulseClip" />`,
  ];
  
  if (metadata.thumbnailUrl) {
    ogTags.push(`<meta property="og:image" content="${metadata.thumbnailUrl}" />`);
    ogTags.push(`<meta property="og:image:width" content="1280" />`);
    ogTags.push(`<meta property="og:image:height" content="720" />`);
  }
  
  if (metadata.durationSeconds !== null) {
    ogTags.push(`<meta property="og:video:duration" content="${metadata.durationSeconds}" />`);
  }
  
  if (metadata.mediaUrl) {
    ogTags.push(`<meta property="og:video" content="${metadata.mediaUrl}" />`);
    ogTags.push(`<meta property="og:video:type" content="video/mp4" />`);
  }
  
  // Twitter Card tags
  ogTags.push(`<meta name="twitter:card" content="summary_large_image" />`);
  ogTags.push(`<meta name="twitter:title" content="${escapeHtml(metadata.title)}" />`);
  ogTags.push(`<meta name="twitter:description" content="${escapeHtml(metadata.description)}" />`);
  if (metadata.thumbnailUrl) {
    ogTags.push(`<meta name="twitter:image" content="${metadata.thumbnailUrl}" />`);
  }
  
  // Update the title tag
  html = html.replace(/<title>.*?<\/title>/, `<title>${escapeHtml(metadata.title)} - PulseClip</title>`);
  
  // Insert OG tags before </head>
  const ogTagsHtml = ogTags.join('\n    ');
  html = html.replace('</head>', `    ${ogTagsHtml}\n  </head>`);
  
  return html;
}

// Helper to escape HTML special characters
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Get artipod info by artipodId
app.get('/api/artipod/:artipodId', (req, res) => {
  const { artipodId } = req.params;
  const artipodPath = join(__dirname, '../artipods', artipodId);
  
  // Check if artipod exists
  if (!existsSync(artipodPath)) {
    return res.status(404).json({ error: 'Artipod not found' });
  }
  
  const mediaFile = findMediaInArtipod(artipodPath);
  if (!mediaFile) {
    return res.status(404).json({ error: 'No media file in artipod' });
  }
  
  const mediaPath = join(artipodPath, mediaFile);
  const stats = statSync(mediaPath);
  // Play the web-friendly copy when one exists — phone captures are HEVC with
  // the index at the end and won't play in most browsers. `filename` still
  // names the original, so edit and export keep working from the source.
  // A missing proxy (not built yet, or not needed) just falls back.
  const playbackFile = existsSync(join(artipodPath, PLAYBACK_PROXY)) ? PLAYBACK_PROXY : mediaFile;
  const fileUrl = `/artipods/${artipodId}/${playbackFile}`;

  // A capture that arrived before this existed still gets one, on first view.
  ensurePlaybackProxy(artipodPath, mediaFile);

  // Check for thumbnail
  const thumbnailFile = ['thumbnail.png', 'thumbnail.jpg'].find(f =>
    existsSync(join(artipodPath, f))
  );
  const thumbnailUrl = thumbnailFile ? `/artipods/${artipodId}/${thumbnailFile}` : undefined;
  
  res.json({
    success: true,
    artipodId,
    filename: mediaFile,
    url: fileUrl,
    localPath: mediaPath,
    size: stats.size,
    thumbnail: thumbnailUrl,
    title: getFeatured().find((f) => f.artipodId === artipodId)?.title ?? readArtipodTitle(artipodPath),
  });
});

// Rename a pulse. Open tier: anyone can title the video they just uploaded
// (they only ever see their own on the homepage). Featured pulses are named
// through the featured dialog instead, so the curated shelf can't be edited
// by visitors.
app.put('/api/artipod/:artipodId/title', (req, res) => {
  const { artipodId } = req.params;
  const artipodPath = join(__dirname, '../artipods', artipodId);
  if (!existsSync(artipodPath) || !findMediaInArtipod(artipodPath)) {
    return res.status(404).json({ error: 'Artipod not found' });
  }
  if (getFeatured().some((f) => f.artipodId === artipodId)) {
    return res.status(409).json({
      error: 'Featured pulses are renamed from the featured dialog',
    });
  }
  const raw = typeof req.body?.title === 'string' ? req.body.title : '';
  // eslint-disable-next-line no-control-regex
  const title = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }
  writeFileSync(join(artipodPath, '.title'), title);
  res.json({ success: true, artipodId, title });
});

// Get editor state (edits and undo history) for an artipod
app.get('/api/artipod/:artipodId/edits', (req, res) => {
  const { artipodId } = req.params;
  const artipodPath = join(__dirname, '../artipods', artipodId);
  
  if (!existsSync(artipodPath)) {
    return res.status(404).json({ error: 'Artipod not found' });
  }
  
  const editsPath = join(artipodPath, 'edits.json');
  
  if (!existsSync(editsPath)) {
    // No edits saved yet
    return res.json({ success: true, hasEdits: false });
  }
  
  try {
    const editsData = readFileSync(editsPath, 'utf-8');
    const edits = JSON.parse(editsData);
    res.json({ success: true, hasEdits: true, ...edits });
  } catch (error) {
    console.error('Failed to read edits:', error);
    res.status(500).json({ error: 'Failed to read editor state' });
  }
});

// Save editor state (protected). Fields not sent keep their saved values, so
// a speed-only save cannot clobber the undo history and vice versa.
app.put('/api/artipod/:artipodId/edits', (req, res) => {
  const { artipodId } = req.params;
  const { editedWords, undoStack, speedMarkers, defaultSpeed, savedAt } = req.body;

  const artipodPath = join(__dirname, '../artipods', artipodId);

  if (!existsSync(artipodPath)) {
    return res.status(404).json({ error: 'Artipod not found' });
  }

  if (!editedWords || !Array.isArray(editedWords)) {
    return res.status(400).json({ error: 'editedWords array is required' });
  }

  try {
    const editsPath = join(artipodPath, 'edits.json');
    let existing: any = {};
    if (existsSync(editsPath)) {
      try {
        existing = JSON.parse(readFileSync(editsPath, 'utf-8'));
      } catch { /* corrupt file: overwrite */ }
    }
    const editsData = {
      editedWords,
      undoStack: undoStack ?? existing.undoStack ?? [],
      speedMarkers: speedMarkers ?? existing.speedMarkers ?? [],
      defaultSpeed: defaultSpeed ?? existing.defaultSpeed ?? 1,
      savedAt: savedAt || new Date().toISOString(),
    };

    writeFileSync(editsPath, JSON.stringify(editsData, null, 2));
    console.log(`Saved edits for artipod ${artipodId}: ${editedWords.length} words, ${editsData.undoStack.length} undo states, ${editsData.speedMarkers.length} speed markers`);

    res.json({ success: true, savedAt: editsData.savedAt });
  } catch (error) {
    console.error('Failed to save edits:', error);
    res.status(500).json({ error: 'Failed to save editor state' });
  }
});

// Delete editor state (protected)
app.delete('/api/artipod/:artipodId/edits', (req, res) => {
  const { artipodId } = req.params;
  const artipodPath = join(__dirname, '../artipods', artipodId);
  
  if (!existsSync(artipodPath)) {
    return res.status(404).json({ error: 'Artipod not found' });
  }
  
  const editsPath = join(artipodPath, 'edits.json');
  
  if (existsSync(editsPath)) {
    unlinkSync(editsPath);
    console.log(`Deleted edits for artipod ${artipodId}`);
  }

  res.json({ success: true });
});

// Export: render the edit list to a new media file with ffmpeg (protected).
// Body may carry { editedWords } (the live editor state); falls back to the
// saved edits.json. Always async — returns 202 + jobId for polling.
app.post('/api/artipod/:artipodId/export', async (req, res) => {
  const { artipodId } = req.params;
  const artipodPath = join(__dirname, '../artipods', artipodId);

  if (!existsSync(artipodPath)) {
    return res.status(404).json({ error: 'Artipod not found' });
  }

  const mediaFile = findMediaInArtipod(artipodPath);
  if (!mediaFile) {
    return res.status(404).json({ error: 'No media file found in artipod' });
  }

  let editedWords = req.body?.editedWords;
  let speedMarkers = req.body?.speedMarkers;
  let defaultSpeed = req.body?.defaultSpeed;
  const burnCaptions = req.body?.captions === true;
  // Optional MIE brand lower-third, rasterized client-side to a PNG data URL
  const lowerThird = typeof req.body?.lowerThird === 'string' ? req.body.lowerThird : undefined;

  // Anything not sent falls back to the saved editor state
  const editsPath = join(artipodPath, 'edits.json');
  if ((!editedWords || !speedMarkers) && existsSync(editsPath)) {
    try {
      const saved = JSON.parse(readFileSync(editsPath, 'utf-8'));
      editedWords = editedWords ?? saved.editedWords;
      speedMarkers = speedMarkers ?? saved.speedMarkers;
      defaultSpeed = defaultSpeed ?? saved.defaultSpeed;
    } catch {
      return res.status(500).json({ error: 'Failed to read saved edits' });
    }
  }

  if (!Array.isArray(editedWords) || editedWords.length === 0) {
    return res.status(400).json({ error: 'editedWords must be a non-empty array' });
  }

  const plan = buildExportPlan(
    editedWords,
    Array.isArray(speedMarkers) ? speedMarkers : [],
    typeof defaultSpeed === 'number' ? defaultSpeed : 1
  );
  if (plan.segments.length === 0) {
    return res.status(400).json({ error: 'Nothing to export: every word is deleted' });
  }

  // The SRT sidecar is written whenever there are caption words; it is only
  // burned into the video when the client asks
  let srtPath: string | null = null;
  let srtUrl: string | undefined;
  if (plan.captionWords.length > 0) {
    srtPath = join(artipodPath, 'export.srt');
    writeFileSync(srtPath, buildSrt(plan.captionWords));
    srtUrl = `/artipods/${artipodId}/export.srt`;
  }

  let burn = burnCaptions;
  if (burn && !(await canBurnSubtitles())) {
    console.warn('Captions requested but this ffmpeg lacks the subtitles filter (libass); rendering without burn');
    burn = false;
  }

  const jobId = randomUUID();
  exportJobs.set(jobId, { id: jobId, status: 'processing', createdAt: Date.now() });
  console.log(
    `Export job ${jobId} started for artipod ${artipodId}: ${plan.segments.length} segments` +
    `${burn ? ', captions burned' : ''}`
  );

  runHeavyJob(`export ${jobId}`, () =>
    renderExport(join(artipodPath, mediaFile), artipodPath, plan, burn ? srtPath : null, lowerThird)
  )
    .then(({ filename, durationMs }) => {
      exportJobs.set(jobId, {
        id: jobId,
        status: 'completed',
        downloadUrl: `/artipods/${artipodId}/${filename}`,
        filename,
        durationMs,
        srtUrl,
        createdAt: Date.now(),
      });
      console.log(`Export job ${jobId} completed: ${filename} (${Math.round(durationMs / 1000)}s)`);
    })
    .catch((error) => {
      exportJobs.set(jobId, {
        id: jobId,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        createdAt: Date.now(),
      });
      console.error(`Export job ${jobId} failed:`, error);
    });

  res.status(202).json({ jobId, status: 'processing', segmentCount: plan.segments.length });
});

// Poll for async export job status
app.get('/api/export/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = exportJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status === 'completed') {
    exportJobs.delete(jobId);
    return res.json({
      status: 'completed',
      downloadUrl: job.downloadUrl,
      filename: job.filename,
      durationMs: job.durationMs,
      srtUrl: job.srtUrl,
    });
  }

  if (job.status === 'error') {
    exportJobs.delete(jobId);
    return res.status(500).json({ error: 'Export failed', message: job.error });
  }

  res.json({ status: 'processing', jobId });
});

// Editorial agent (protected): an LLM reads the transcript and proposes content
// deletions (fillers, false starts, repeats). The proposal is written to
// edits.json for the human to review in the editor — NEVER auto-exported. The
// prior editor state is kept as a single undo snapshot, and saved speed
// settings are preserved. Always async — returns 202 + jobId for polling.
app.post('/api/artipod/:artipodId/agent-edit', requireAuth, (req, res) => {
  const { artipodId } = req.params;
  const artipodPath = join(__dirname, '../artipods', artipodId);

  if (!existsSync(artipodPath)) {
    return res.status(404).json({ error: 'Artipod not found' });
  }

  const words = req.body?.words;
  const instructions = typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : '';

  if (!Array.isArray(words) || words.length === 0) {
    return res.status(400).json({ error: 'words must be a non-empty array of transcript words' });
  }
  if (!instructions) {
    return res.status(400).json({ error: 'Tell the agent what to do — an instruction is required.' });
  }

  // One agent run per pulse at a time. Two concurrent runs both read edits.json,
  // both write it, and the loser's checkpoint is gone — the person sees an edit
  // they never asked for and a history entry that vanished. Rejecting is the
  // honest outcome: the caller knows their run didn't happen, which a silent
  // overwrite never tells them.
  const running = agentLocks.get(artipodId);
  if (running) {
    return res.status(409).json({
      error: 'Busy',
      message: 'An AI edit is already running on this pulse. Wait for it to finish.',
      jobId: running,
    });
  }

  const jobId = randomUUID();
  agentLocks.set(artipodId, jobId);
  agentJobs.set(jobId, { id: jobId, status: 'processing', createdAt: Date.now() });
  console.log(`Agent-edit job ${jobId} started for artipod ${artipodId}: ${words.length} transcript words`);

  (async () => {
    const editsPath = join(artipodPath, 'edits.json');
    let existing: any = {};
    if (existsSync(editsPath)) {
      try { existing = JSON.parse(readFileSync(editsPath, 'utf-8')); } catch { existing = {}; }
    }
    const priorEditedWords =
      Array.isArray(existing.editedWords) && existing.editedWords.length > 0
        ? existing.editedWords
        : buildBaseline(words);
    const priorUndoStack = Array.isArray(existing.undoStack) ? existing.undoStack : [];
    const priorSpeedMarkers = Array.isArray(existing.speedMarkers) ? existing.speedMarkers : [];
    const priorDefaultSpeed =
      typeof existing.defaultSpeed === 'number' ? existing.defaultSpeed : 1;

    // Hand the model its own last turn so a follow-up ("now make it shorter")
    // is a revision rather than a fresh guess. Checkpoint 0 is the untouched
    // original, so only a later one describes something the agent did.
    const lastAgentRun =
      Array.isArray(existing.checkpoints) && existing.checkpoints.length > 1
        ? existing.checkpoints[existing.checkpoints.length - 1]
        : null;

    const result = await generateAgentEdit({
      words,
      instructions,
      defaultSpeed: priorDefaultSpeed,
      prior:
        lastAgentRun && Array.isArray(lastAgentRun.ops)
          ? {
              instruction: lastAgentRun.label,
              ops: lastAgentRun.ops,
              durationMs: lastAgentRun.durationMs,
            }
          : undefined,
    });

    // Two histories, different jobs. undoStack is the editor's ⌘Z — fine-grained
    // and word-level. Checkpoints are commits: one per agent run, labelled with
    // the instruction that produced it, holding the COMPLETE state. Word-only
    // snapshots would silently lose speed and ordering once ops can change them,
    // leaving a mixed state that never existed.
    const priorCheckpoints = Array.isArray(existing.checkpoints) ? existing.checkpoints : [];
    const checkpoints = [...priorCheckpoints];
    if (checkpoints.length === 0) {
      checkpoints.push({
        at: existing.savedAt || new Date().toISOString(),
        label: 'Before AI edits',
        editedWords: priorEditedWords,
        speedMarkers: priorSpeedMarkers,
        defaultSpeed: priorDefaultSpeed,
      });
    }
    checkpoints.push({
      at: new Date().toISOString(),
      label: instructions,
      summary: result.summary,
      ops: result.ops,
      // Persisted so the next run can be told how long its own last edit ran
      durationMs: result.durationMs,
      editedWords: result.editedWords,
      speedMarkers: result.speedMarkers,
      defaultSpeed: priorDefaultSpeed,
    });
    // Cap the history, but never drop the original — it is the one people
    // reach for when an iteration goes wrong.
    while (checkpoints.length > MAX_CHECKPOINTS) checkpoints.splice(1, 1);

    const editsData = {
      editedWords: result.editedWords,
      undoStack: [...priorUndoStack, priorEditedWords],
      speedMarkers: result.speedMarkers,
      defaultSpeed: priorDefaultSpeed,
      checkpoints,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(editsPath, JSON.stringify(editsData, null, 2));

    return result;
  })()
    .then((result) => {
      agentJobs.set(jobId, {
        id: jobId,
        status: 'completed',
        result: {
          summary: result.summary,
          ops: result.ops,
          deletedCount: result.deletedCount,
          contentCount: result.contentCount,
          silenceCount: result.silenceCount,
          durationMs: result.durationMs,
          targetSeconds: result.targetSeconds,
          rounds: result.rounds,
          provider: result.provider,
          model: result.model,
        },
        createdAt: Date.now(),
      });
      console.log(
        `Agent-edit job ${jobId} completed: deleted ${result.deletedCount}/${result.contentCount} words + ${result.silenceCount} silences (${result.provider}/${result.model})`
      );
    })
    .catch((error) => {
      const notConfigured = error instanceof AgentNotConfiguredError;
      agentJobs.set(jobId, {
        id: jobId,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        notConfigured,
        createdAt: Date.now(),
      });
      console.error(`Agent-edit job ${jobId} failed:`, error);
    })
    .finally(() => {
      // Only clear if we still own it. A lock re-taken by a later run must not
      // be released by this one finishing late.
      if (agentLocks.get(artipodId) === jobId) agentLocks.delete(artipodId);
    });

  res.status(202).json({ jobId, status: 'processing' });
});

// Poll for async agent-edit job status
app.get('/api/agent-edit/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = agentJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status === 'completed') {
    agentJobs.delete(jobId);
    return res.json({ status: 'completed', ...job.result });
  }

  if (job.status === 'error') {
    agentJobs.delete(jobId);
    // 503 when the server simply has no LLM configured (e.g. the dev box before
    // a key is seeded); 500 for a genuine LLM/validation failure.
    return res.status(job.notConfigured ? 503 : 500).json({
      error: 'Agent edit failed',
      message: job.error,
      notConfigured: job.notConfigured,
    });
  }

  res.json({ status: 'processing', jobId });
});

/**
 * Roll the edit state back to a checkpoint — "scrap that, go back to how it was".
 *
 * Restoring does not truncate the history: later checkpoints stay listed so a
 * rollback is itself reversible. The current state becomes a copy of the chosen
 * checkpoint; nothing is destroyed.
 */
app.post('/api/artipod/:artipodId/edits/restore', requireAuth, (req, res) => {
  const { artipodId } = req.params;
  const editsPath = join(__dirname, '../artipods', artipodId, 'edits.json');

  if (!existsSync(editsPath)) {
    return res.status(404).json({ error: 'No saved edits for this artipod' });
  }

  let edits: any;
  try {
    edits = JSON.parse(readFileSync(editsPath, 'utf-8'));
  } catch {
    return res.status(500).json({ error: 'Could not read the saved edits' });
  }

  const checkpoints = Array.isArray(edits.checkpoints) ? edits.checkpoints : [];
  const index = Number(req.body?.index);
  if (!Number.isInteger(index) || index < 0 || index >= checkpoints.length) {
    return res.status(400).json({
      error: `index must be between 0 and ${Math.max(0, checkpoints.length - 1)}`,
    });
  }

  const target = checkpoints[index];
  const restored = {
    ...edits,
    editedWords: target.editedWords,
    speedMarkers: Array.isArray(target.speedMarkers) ? target.speedMarkers : [],
    defaultSpeed: typeof target.defaultSpeed === 'number' ? target.defaultSpeed : 1,
    // The editor's own ⌘Z history describes a different sequence of states and
    // would be misleading against restored words, so it starts clean.
    undoStack: [],
    savedAt: new Date().toISOString(),
  };
  writeFileSync(editsPath, JSON.stringify(restored, null, 2));
  console.log(`Restored artipod ${artipodId} to checkpoint ${index} ("${target.label}")`);

  res.json({ success: true, index, label: target.label });
});

// Legacy route - redirect old filename format to artipod lookup
app.get('/api/file/:filename', (req, res) => {
  const { filename } = req.params;
  // Check if it's a UUID (artipodId)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(filename)) {
    // Redirect to artipod endpoint
    return res.redirect(307, `/api/artipod/${filename}`);
  }
  
  // Legacy: try to find file in old flat structure
  const localPath = join(__dirname, '../artipods', filename);
  if (!existsSync(localPath) || !statSync(localPath).isFile()) {
    return res.status(404).json({ error: 'Pulse not found' });
  }
  
  const stats = statSync(localPath);
  const fileUrl = `/artipods/${filename}`;
  
  res.json({
    success: true,
    filename,
    url: fileUrl,
    localPath,
    size: stats.size,
  });
});

// Delete artipod (protected)
app.delete('/api/artipod/:artipodId', requireAuth, async (req, res) => {
  const { artipodId } = req.params;
  const artipodPath = join(__dirname, '../artipods', artipodId);
  
  // Check if artipod exists
  if (!existsSync(artipodPath)) {
    return res.status(404).json({ error: 'Artipod not found' });
  }
  
  try {
    const mediaFile = findMediaInArtipod(artipodPath);
    let cacheRemoved = 0;
    
    if (mediaFile) {
      const mediaPath = join(artipodPath, mediaFile);
      // Remove cache entries for this artipod (while file still exists for hash computation)
      cacheRemoved = await removeCacheForFile(mediaPath);
    }
    
    // Remove featured entry if exists
    const featuredRemoved = removeFeatured(artipodId);
    
    // Delete the entire artipod folder
    rmSync(artipodPath, { recursive: true, force: true });
    
    console.log(`Deleted artipod: ${artipodId} (cache entries: ${cacheRemoved}, was featured: ${featuredRemoved})`);
    
    res.json({
      success: true,
      message: 'Artipod deleted',
      cacheEntriesRemoved: cacheRemoved,
      featuredRemoved,
    });
  } catch (error) {
    console.error('Artipod deletion error:', error);
    res.status(500).json({
      error: 'Failed to delete artipod',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Legacy delete route
app.delete('/api/file/:filename', requireAuth, async (req, res) => {
  const { filename } = req.params;
  // Check if it's a UUID (artipodId)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(filename)) {
    return res.redirect(307, `/api/artipod/${filename}`);
  }
  
  const localPath = join(__dirname, '../artipods', filename);
  
  // Check if pulse exists
  if (!existsSync(localPath)) {
    return res.status(404).json({ error: 'Pulse not found' });
  }
  
  try {
    // Remove cache entries for this pulse first (while file still exists for hash computation)
    const cacheRemoved = await removeCacheForFile(localPath);
    
    // Remove featured entry if exists
    const featuredRemoved = removeFeatured(filename);
    
    // Delete the actual file
    unlinkSync(localPath);
    
    console.log(`Deleted pulse: ${filename} (cache entries: ${cacheRemoved}, was featured: ${featuredRemoved})`);
    
    res.json({
      success: true,
      message: 'Pulse deleted',
      cacheEntriesRemoved: cacheRemoved,
      featuredRemoved,
    });
  } catch (error) {
    console.error('Pulse deletion error:', error);
    res.status(500).json({
      error: 'Failed to delete pulse',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Cache management endpoints
app.get('/api/cache/stats', (_req, res) => {
  const stats = getCacheStats();
  res.json(stats);
});

app.delete('/api/cache', requireAuth, (_req, res) => {
  clearCache();
  res.json({ success: true, message: 'Cache cleared' });
});

// Featured pulse management endpoints

// Get list of featured pulses (public)
app.get('/api/featured', (_req, res) => {
  const featured = getFeatured();
  res.json({ featured });
});

// Check if a pulse is featured (public)
app.get('/api/featured/:filename', (req, res) => {
  const { filename } = req.params;
  const featured = isFeatured(filename);
  res.json({ isFeatured: featured });
});

// Upload thumbnail (protected) - saves thumbnail.png inside artipod folder
app.post('/api/thumbnail', requireAuth, (req, res) => {
  const { imageData, artipodId } = req.body;
  
  if (!imageData || !artipodId) {
    return res.status(400).json({ error: 'imageData and artipodId are required' });
  }
  
  try {
    const artipodPath = join(__dirname, '../artipods', artipodId);
    
    // Verify artipod exists
    if (!existsSync(artipodPath)) {
      return res.status(404).json({ error: 'Artipod not found' });
    }
    
    // Parse base64 data (format: data:image/png;base64,...)
    const matches = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ error: 'Invalid image data format' });
    }
    
    const extension = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Save as thumbnail.png (or .jpg) inside the artipod folder
    const thumbFilename = `thumbnail.${extension}`;
    const thumbPath = join(artipodPath, thumbFilename);
    
    writeFileSync(thumbPath, buffer);
    
    const thumbUrl = `/artipods/${artipodId}/${thumbFilename}`;
    console.log(`Saved thumbnail for artipod ${artipodId}: ${thumbFilename}`);
    
    res.json({ success: true, url: thumbUrl });
  } catch (error) {
    console.error('Thumbnail upload error:', error);
    res.status(500).json({
      error: 'Failed to save thumbnail',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Add or update a featured pulse (protected) - now uses artipodId
app.post('/api/featured', requireAuth, (req, res) => {
  const { artipodId, title, thumbnail } = req.body;
  
  if (!artipodId) {
    return res.status(400).json({ error: 'artipodId is required' });
  }
  
  // Verify artipod exists
  const artipodPath = join(__dirname, '../artipods', artipodId);
  if (!existsSync(artipodPath)) {
    return res.status(404).json({ error: 'Artipod not found' });
  }
  
  const pulse = addFeatured(artipodId, title || artipodId, thumbnail);
  res.json({ success: true, pulse });
});

// Remove a featured pulse (protected)
app.delete('/api/featured/:filename', requireAuth, (req, res) => {
  const { filename } = req.params;
  const removed = removeFeatured(filename);
  
  if (!removed) {
    return res.status(404).json({ error: 'Featured pulse not found' });
  }
  
  res.json({ success: true });
});

// Artipod page with Open Graph meta tags for social sharing previews (iMessage, Twitter, Facebook, etc.)
app.get('/artipod/:artipodId', (req, res, next) => {
  // Skip if this is an API request or not requesting HTML
  const acceptHeader = req.headers.accept || '';
  if (!acceptHeader.includes('text/html')) {
    return next();
  }
  
  const { artipodId } = req.params;
  
  // Validate artipodId format (UUID)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(artipodId)) {
    return next();
  }
  
  // Get base URL from request
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const baseUrl = `${protocol}://${host}`;
  
  // Get artipod metadata
  const metadata = getArtipodMetadata(artipodId, baseUrl);
  if (!metadata) {
    return next(); // Fall through to SPA fallback for 404 handling
  }
  
  // Generate and send HTML with OG meta tags
  const html = generateOgHtml(metadata, artipodId, baseUrl);
  res.type('html').send(html);
});

// SPA fallback - serve index.html for all non-API routes (must be after all other routes)
if (existsSync(clientDistPath)) {
  app.get('*', (_req, res) => {
    res.sendFile(join(clientDistPath, 'index.html'));
  });
}

app.listen(port, () => {
  console.log(`Available providers: ${providerRegistry.list().map((p) => p.displayName).join(', ')}`);
  console.log(`Server running on http://localhost:${port}`);
  if (existsSync(clientDistPath)) {
    console.log(`Serving client from ${clientDistPath}`);
  }
});
