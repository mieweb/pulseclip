import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, statSync, unlinkSync, mkdirSync, writeFileSync } from 'fs';
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

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, join(__dirname, '../uploads'));
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
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

// Serve uploaded files
app.use('/uploads', express.static(join(__dirname, '../uploads')));

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

// Upload pulse (protected)
app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const fileUrl = `/uploads/${req.file.filename}`;
  const localPath = join(__dirname, '../uploads', req.file.filename);

  res.json({
    success: true,
    filename: req.file.filename,
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

    // Extract filename from URL and build local path for file upload to provider
    const filename = mediaUrl.split('/').pop();
    const localPath = join(__dirname, '../uploads', filename || '');

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

// Get pulse info by filename
app.get('/api/file/:filename', (req, res) => {
  const { filename } = req.params;
  const localPath = join(__dirname, '../uploads', filename);
  
  // Check if pulse exists
  if (!existsSync(localPath)) {
    return res.status(404).json({ error: 'Pulse not found' });
  }
  
  const stats = statSync(localPath);
  const fileUrl = `/uploads/${filename}`;
  
  res.json({
    success: true,
    filename,
    url: fileUrl,
    localPath,
    size: stats.size,
  });
});

// Delete pulse (protected)
app.delete('/api/file/:filename', requireAuth, async (req, res) => {
  const { filename } = req.params;
  const localPath = join(__dirname, '../uploads', filename);
  
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

// Upload thumbnail (protected) - accepts base64 image data
app.post('/api/thumbnail', requireAuth, (req, res) => {
  const { imageData, filename } = req.body;
  
  if (!imageData || !filename) {
    return res.status(400).json({ error: 'imageData and filename are required' });
  }
  
  try {
    // Ensure thumbnails directory exists
    const thumbDir = join(__dirname, '../uploads/thumbnails');
    if (!existsSync(thumbDir)) {
      mkdirSync(thumbDir, { recursive: true });
    }
    
    // Parse base64 data (format: data:image/png;base64,...)
    const matches = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ error: 'Invalid image data format' });
    }
    
    const extension = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Create unique filename based on the media filename
    const thumbFilename = `${filename.replace(/\.[^.]+$/, '')}-thumb.${extension}`;
    const thumbPath = join(thumbDir, thumbFilename);
    
    writeFileSync(thumbPath, buffer);
    
    const thumbUrl = `/uploads/thumbnails/${thumbFilename}`;
    console.log(`Saved thumbnail: ${thumbFilename}`);
    
    res.json({ success: true, url: thumbUrl });
  } catch (error) {
    console.error('Thumbnail upload error:', error);
    res.status(500).json({
      error: 'Failed to save thumbnail',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Add or update a featured pulse (protected)
app.post('/api/featured', requireAuth, (req, res) => {
  const { filename, title, thumbnail } = req.body;
  
  if (!filename) {
    return res.status(400).json({ error: 'filename is required' });
  }
  
  // Verify pulse exists
  const localPath = join(__dirname, '../uploads', filename);
  if (!existsSync(localPath)) {
    return res.status(404).json({ error: 'Pulse not found' });
  }
  
  const pulse = addFeatured(filename, title || filename, thumbnail);
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
