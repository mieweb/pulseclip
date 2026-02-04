import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { initializeProviders } from './providers/registry.js';

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

  res.json({
    success: true,
    filename: req.file.filename,
    url: fileUrl,
    size: req.file.size,
    mimetype: req.file.mimetype,
  });
});

// Transcribe with selected provider
app.post('/api/transcribe', async (req, res) => {
  try {
    const { mediaUrl, providerId, options } = req.body;

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

    console.log(`Starting transcription with ${provider.displayName}...`);
    const result = await provider.transcribe(mediaUrl, options);
    console.log(`Transcription complete. Words: ${result.normalized.words.length}`);

    res.json({
      success: true,
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

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`Available providers: ${providerRegistry.list().map((p) => p.displayName).join(', ')}`);
});
