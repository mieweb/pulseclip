import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, statSync } from 'fs';
import dotenv from 'dotenv';
import { initializeProviders } from './providers/registry.js';
import { getCachedTranscription, cacheTranscription, getCacheStats, clearCache } from './cache.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3001;

// Initialize provider registry
const providerRegistry = initializeProviders();

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
app.use(express.json());

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

// Upload file
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const fileUrl = `http://localhost:${port}/uploads/${req.file.filename}`;
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

// Transcribe with selected provider
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

    // Check cache first (unless skipCache is true)
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

// Get file info by filename
app.get('/api/file/:filename', (req, res) => {
  const { filename } = req.params;
  const localPath = join(__dirname, '../uploads', filename);
  
  // Check if file exists
  if (!existsSync(localPath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  const stats = statSync(localPath);
  const fileUrl = `http://localhost:${port}/uploads/${filename}`;
  
  res.json({
    success: true,
    filename,
    url: fileUrl,
    localPath,
    size: stats.size,
  });
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
