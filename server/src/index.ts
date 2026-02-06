import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, statSync, unlinkSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'fs';
import dotenv from 'dotenv';
import { initializeProviders } from './providers/registry.js';
import { getCachedTranscription, cacheTranscription, getCacheStats, clearCache, removeCacheForFile } from './cache.js';
import { getFeatured, addFeatured, removeFeatured, isFeatured } from './featured.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Initialize provider registry
const providerRegistry = initializeProviders();

// Secret key for protected endpoints
const secretKey = process.env.SECRET_KEY;

// Auth middleware for protected endpoints
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
    fileSize: 500 * 1024 * 1024, // 500MB limit
  },
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increased limit for base64 image uploads

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

// Get available providers
app.get('/api/providers', (_req, res) => {
  const providers = providerRegistry.list();
  res.json({ providers });
});

// Upload pulse (protected) - creates an artipod folder with UUID
app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const artipodId = (req as any).artipodId;
  const fileUrl = `/artipods/${artipodId}/${req.file.originalname}`;
  const localPath = join(__dirname, '../artipods', artipodId, req.file.originalname);

  res.json({
    success: true,
    artipodId,
    filename: req.file.originalname,
    url: fileUrl,
    localPath,
    size: req.file.size,
    mimetype: req.file.mimetype,
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

    // Auth required for actual transcription (uses paid API)
    if (secretKey) {
      const providedKey = req.headers['x-api-key'] as string;
      if (!providedKey || providedKey !== secretKey) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Valid API key required for transcription' });
      }
    }

    console.log(`Starting transcription with ${provider.displayName}...`);
    console.log(`Using local file: ${localPath}`);
    const result = await provider.transcribe(localPath, options);
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

// Helper to find media file in artipod folder
function findMediaInArtipod(artipodPath: string): string | null {
  if (!existsSync(artipodPath)) return null;
  const files = readdirSync(artipodPath);
  // Find the first media file (exclude known asset files)
  const assetFiles = ['thumbnail.png', 'thumbnail.jpg', 'transcript.json', 'beats.json', 'edits.json'];
  const mediaFile = files.find(f => !assetFiles.includes(f) && !f.startsWith('.'));
  return mediaFile || null;
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
  const fileUrl = `/artipods/${artipodId}/${mediaFile}`;
  
  // Check for thumbnail
  const thumbnailPath = join(artipodPath, 'thumbnail.png');
  const thumbnailUrl = existsSync(thumbnailPath) ? `/artipods/${artipodId}/thumbnail.png` : undefined;
  
  res.json({
    success: true,
    artipodId,
    filename: mediaFile,
    url: fileUrl,
    localPath: mediaPath,
    size: stats.size,
    thumbnail: thumbnailUrl,
  });
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

// Save editor state (protected)
app.put('/api/artipod/:artipodId/edits', requireAuth, (req, res) => {
  const { artipodId } = req.params;
  const { editedWords, undoStack, savedAt } = req.body;
  
  const artipodPath = join(__dirname, '../artipods', artipodId);
  
  if (!existsSync(artipodPath)) {
    return res.status(404).json({ error: 'Artipod not found' });
  }
  
  if (!editedWords || !Array.isArray(editedWords)) {
    return res.status(400).json({ error: 'editedWords array is required' });
  }
  
  try {
    const editsPath = join(artipodPath, 'edits.json');
    const editsData = {
      editedWords,
      undoStack: undoStack || [],
      savedAt: savedAt || new Date().toISOString(),
    };
    
    writeFileSync(editsPath, JSON.stringify(editsData, null, 2));
    console.log(`Saved edits for artipod ${artipodId}: ${editedWords.length} words, ${undoStack?.length || 0} undo states`);
    
    res.json({ success: true, savedAt: editsData.savedAt });
  } catch (error) {
    console.error('Failed to save edits:', error);
    res.status(500).json({ error: 'Failed to save editor state' });
  }
});

// Delete editor state (protected)
app.delete('/api/artipod/:artipodId/edits', requireAuth, (req, res) => {
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

app.delete('/api/cache', (_req, res) => {
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
