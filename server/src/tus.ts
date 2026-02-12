/**
 * TUS Protocol Implementation for resumable uploads
 * https://tus.io/protocols/resumable-upload.html
 * 
 * Supports PulseCam mobile app uploads with:
 * - Resumable chunked uploads
 * - Checksum-based duplicate detection
 * - Automatic artipod creation
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, statSync, unlinkSync, readdirSync, renameSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction, Router } from 'express';
import express from 'express';

// Directory for temporary TUS uploads
const TUS_UPLOADS_DIR = join(process.cwd(), 'tus-uploads');
const ARTIPODS_DIR = join(process.cwd(), 'artipods');
const CHECKSUMS_FILE = join(process.cwd(), 'data', 'checksums.json');

// Ensure directories exist
if (!existsSync(TUS_UPLOADS_DIR)) {
  mkdirSync(TUS_UPLOADS_DIR, { recursive: true });
}
if (!existsSync(join(process.cwd(), 'data'))) {
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
}

interface TusUpload {
  id: string;
  length: number;
  offset: number;
  metadata: Record<string, string>;
  createdAt: string;
  filePath: string;
}

interface ChecksumEntry {
  checksum: string;
  artipodId: string;
  filename: string;
  createdAt: string;
}

interface ChecksumsIndex {
  checksums: Record<string, ChecksumEntry>;
}

/**
 * Load checksums index from disk
 */
function loadChecksums(): ChecksumsIndex {
  try {
    if (existsSync(CHECKSUMS_FILE)) {
      return JSON.parse(readFileSync(CHECKSUMS_FILE, 'utf-8'));
    }
  } catch (error) {
    console.error('[TUS] Failed to load checksums:', error);
  }
  return { checksums: {} };
}

/**
 * Save checksums index to disk
 */
function saveChecksums(index: ChecksumsIndex): void {
  try {
    writeFileSync(CHECKSUMS_FILE, JSON.stringify(index, null, 2));
  } catch (error) {
    console.error('[TUS] Failed to save checksums:', error);
  }
}

/**
 * Calculate SHA-256 checksum of a file
 */
function calculateChecksum(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Find existing artipod by checksum
 */
export function findArtipodByChecksum(checksum: string): ChecksumEntry | null {
  const index = loadChecksums();
  return index.checksums[checksum] || null;
}

/**
 * Register a new checksum -> artipod mapping
 */
export function registerChecksum(checksum: string, artipodId: string, filename: string): void {
  const index = loadChecksums();
  index.checksums[checksum] = {
    checksum,
    artipodId,
    filename,
    createdAt: new Date().toISOString(),
  };
  saveChecksums(index);
}

/**
 * Get upload metadata from disk
 */
function getUpload(uploadId: string): TusUpload | null {
  const metaPath = join(TUS_UPLOADS_DIR, `${uploadId}.json`);
  try {
    if (existsSync(metaPath)) {
      return JSON.parse(readFileSync(metaPath, 'utf-8'));
    }
  } catch (error) {
    console.error(`[TUS] Failed to read upload ${uploadId}:`, error);
  }
  return null;
}

/**
 * Save upload metadata to disk
 */
function saveUpload(upload: TusUpload): void {
  const metaPath = join(TUS_UPLOADS_DIR, `${upload.id}.json`);
  writeFileSync(metaPath, JSON.stringify(upload, null, 2));
}

/**
 * Delete upload and associated files
 */
function deleteUpload(uploadId: string): void {
  const metaPath = join(TUS_UPLOADS_DIR, `${uploadId}.json`);
  const dataPath = join(TUS_UPLOADS_DIR, `${uploadId}.bin`);
  
  try {
    if (existsSync(metaPath)) unlinkSync(metaPath);
    if (existsSync(dataPath)) unlinkSync(dataPath);
  } catch (error) {
    console.error(`[TUS] Failed to delete upload ${uploadId}:`, error);
  }
}

/**
 * Parse TUS Upload-Metadata header
 * Format: key1 base64value1, key2 base64value2
 */
function parseMetadata(header: string | undefined): Record<string, string> {
  if (!header) return {};
  
  const metadata: Record<string, string> = {};
  const pairs = header.split(',').map(s => s.trim());
  
  for (const pair of pairs) {
    const [key, value] = pair.split(' ');
    if (key && value) {
      try {
        metadata[key] = Buffer.from(value, 'base64').toString('utf-8');
      } catch {
        metadata[key] = value;
      }
    } else if (key) {
      metadata[key] = '';
    }
  }
  
  return metadata;
}

/**
 * Create TUS router with all upload endpoints
 */
export function createTusRouter(): Router {
  const router = express.Router();

  // TUS protocol requires raw body parsing for PATCH requests
  router.use(express.raw({ 
    type: 'application/offset+octet-stream',
    limit: '100mb' 
  }));

  /**
   * OPTIONS /uploads - TUS capabilities discovery
   */
  router.options('/', (_req: Request, res: Response) => {
    res.set({
      'Tus-Resumable': '1.0.0',
      'Tus-Version': '1.0.0',
      'Tus-Extension': 'creation,termination',
      'Tus-Max-Size': String(500 * 1024 * 1024), // 500MB
    });
    res.status(204).end();
  });

  /**
   * POST /uploads - Create new upload
   */
  router.post('/', (req: Request, res: Response) => {
    const uploadLength = parseInt(req.headers['upload-length'] as string, 10);
    
    if (isNaN(uploadLength) || uploadLength <= 0) {
      return res.status(400).json({ error: 'Invalid Upload-Length header' });
    }

    const uploadId = randomUUID();
    const metadata = parseMetadata(req.headers['upload-metadata'] as string);
    const filePath = join(TUS_UPLOADS_DIR, `${uploadId}.bin`);

    // Create empty file
    writeFileSync(filePath, Buffer.alloc(0));

    const upload: TusUpload = {
      id: uploadId,
      length: uploadLength,
      offset: 0,
      metadata,
      createdAt: new Date().toISOString(),
      filePath,
    };

    saveUpload(upload);

    console.log(`[TUS] Created upload ${uploadId} (${uploadLength} bytes)`);

    // Return Location header with upload URL
    const location = `/uploads/${uploadId}`;
    res.set({
      'Location': location,
      'Tus-Resumable': '1.0.0',
    });
    res.status(201).end();
  });

  /**
   * HEAD /uploads/:id - Get upload status
   */
  router.head('/:id', (req: Request, res: Response) => {
    const upload = getUpload(req.params.id);
    
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    res.set({
      'Upload-Offset': String(upload.offset),
      'Upload-Length': String(upload.length),
      'Tus-Resumable': '1.0.0',
      'Cache-Control': 'no-store',
    });
    res.status(200).end();
  });

  /**
   * PATCH /uploads/:id - Append data to upload
   */
  router.patch('/:id', async (req: Request, res: Response) => {
    const upload = getUpload(req.params.id);
    
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    const contentType = req.headers['content-type'];
    if (contentType !== 'application/offset+octet-stream') {
      return res.status(415).json({ error: 'Invalid Content-Type' });
    }

    const uploadOffset = parseInt(req.headers['upload-offset'] as string, 10);
    if (isNaN(uploadOffset)) {
      return res.status(400).json({ error: 'Invalid Upload-Offset header' });
    }

    if (uploadOffset !== upload.offset) {
      return res.status(409).json({ 
        error: 'Offset mismatch',
        expected: upload.offset,
        received: uploadOffset,
      });
    }

    // Get the raw body data
    const chunk = req.body as Buffer;
    if (!chunk || chunk.length === 0) {
      return res.status(400).json({ error: 'No data received' });
    }

    // Append chunk to file
    appendFileSync(upload.filePath, chunk);
    
    // Update offset
    upload.offset += chunk.length;
    saveUpload(upload);

    console.log(`[TUS] Upload ${upload.id}: ${upload.offset}/${upload.length} bytes (${Math.round(upload.offset / upload.length * 100)}%)`);

    res.set({
      'Upload-Offset': String(upload.offset),
      'Tus-Resumable': '1.0.0',
    });

    // Check if upload is complete
    if (upload.offset >= upload.length) {
      try {
        const result = await finalizeUpload(upload);
        res.set({
          'X-Artipod-Id': result.artipodId,
          'X-Duplicate': result.duplicate ? 'true' : 'false',
        });
        console.log(`[TUS] Upload ${upload.id} complete -> artipod ${result.artipodId}${result.duplicate ? ' (duplicate)' : ''}`);
      } catch (error) {
        console.error(`[TUS] Failed to finalize upload ${upload.id}:`, error);
        return res.status(500).json({ error: 'Failed to finalize upload' });
      }
    }

    res.status(204).end();
  });

  /**
   * DELETE /uploads/:id - Cancel upload
   */
  router.delete('/:id', (req: Request, res: Response) => {
    const upload = getUpload(req.params.id);
    
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    deleteUpload(upload.id);
    console.log(`[TUS] Deleted upload ${upload.id}`);

    res.set({ 'Tus-Resumable': '1.0.0' });
    res.status(204).end();
  });

  /**
   * GET /uploads/:id/status - Get upload status with artipod info (extension)
   */
  router.get('/:id/status', (req: Request, res: Response) => {
    const upload = getUpload(req.params.id);
    
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    res.json({
      id: upload.id,
      length: upload.length,
      offset: upload.offset,
      complete: upload.offset >= upload.length,
      metadata: upload.metadata,
      createdAt: upload.createdAt,
    });
  });

  return router;
}

/**
 * Finalize a completed upload - move to artipods folder with duplicate detection
 */
async function finalizeUpload(upload: TusUpload): Promise<{ artipodId: string; duplicate: boolean }> {
  // Calculate checksum
  const checksum = calculateChecksum(upload.filePath);
  
  // Check for existing file with same checksum
  const existing = findArtipodByChecksum(checksum);
  if (existing) {
    // Delete the uploaded file - we already have it
    deleteUpload(upload.id);
    return { artipodId: existing.artipodId, duplicate: true };
  }

  // Create new artipod
  const artipodId = randomUUID();
  const artipodPath = join(ARTIPODS_DIR, artipodId);
  mkdirSync(artipodPath, { recursive: true });

  // Determine filename from metadata or default
  const filename = upload.metadata.filename || 'video.mp4';
  const destPath = join(artipodPath, filename);

  // Move file to artipod
  renameSync(upload.filePath, destPath);
  
  // Register checksum
  registerChecksum(checksum, artipodId, filename);

  // Delete metadata file
  const metaPath = join(TUS_UPLOADS_DIR, `${upload.id}.json`);
  if (existsSync(metaPath)) {
    unlinkSync(metaPath);
  }

  return { artipodId, duplicate: false };
}

/**
 * Generate a PulseCam deep link URL
 */
export function generatePulseCamDeepLink(serverUrl: string, token?: string): string {
  const params = new URLSearchParams({
    mode: 'upload',
    server: serverUrl,
  });
  
  if (token) {
    params.set('token', token);
  }

  return `pulsecam://?${params.toString()}`;
}

/**
 * Clean up stale uploads older than 24 hours
 */
export function cleanupStaleUploads(): void {
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();

  try {
    const files = readdirSync(TUS_UPLOADS_DIR);
    
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      
      const uploadId = file.replace('.json', '');
      const upload = getUpload(uploadId);
      
      if (upload) {
        const age = now - new Date(upload.createdAt).getTime();
        if (age > maxAge) {
          console.log(`[TUS] Cleaning up stale upload ${uploadId} (${Math.round(age / 1000 / 60)} minutes old)`);
          deleteUpload(uploadId);
        }
      }
    }
  } catch (error) {
    console.error('[TUS] Failed to cleanup stale uploads:', error);
  }
}
