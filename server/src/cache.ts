import { createHash } from 'crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CACHE_DIR = join(__dirname, '../cache');
const CACHE_INDEX_FILE = join(CACHE_DIR, 'index.json');

interface CacheEntry {
  fileHash: string;
  providerId: string;
  createdAt: string;
  result: any;
}

interface CacheIndex {
  entries: Record<string, CacheEntry>;
}

// Ensure cache directory exists
function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

// Load cache index
function loadCacheIndex(): CacheIndex {
  ensureCacheDir();
  if (!existsSync(CACHE_INDEX_FILE)) {
    return { entries: {} };
  }
  try {
    const data = readFileSync(CACHE_INDEX_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { entries: {} };
  }
}

// Save cache index
function saveCacheIndex(index: CacheIndex): void {
  ensureCacheDir();
  writeFileSync(CACHE_INDEX_FILE, JSON.stringify(index, null, 2));
}

// Compute MD5 hash of a file
export async function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    const stream = createReadStream(filePath);
    
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Generate cache key from file hash and provider
function getCacheKey(fileHash: string, providerId: string): string {
  return `${fileHash}-${providerId}`;
}

// Get cached transcription result
export async function getCachedTranscription(
  filePath: string,
  providerId: string
): Promise<any | null> {
  try {
    const fileHash = await computeFileHash(filePath);
    const cacheKey = getCacheKey(fileHash, providerId);
    const index = loadCacheIndex();
    
    const entry = index.entries[cacheKey];
    if (entry) {
      console.log(`Cache HIT for ${cacheKey}`);
      return entry.result;
    }
    
    console.log(`Cache MISS for ${cacheKey}`);
    return null;
  } catch (error) {
    console.error('Cache lookup error:', error);
    return null;
  }
}

// Store transcription result in cache
export async function cacheTranscription(
  filePath: string,
  providerId: string,
  result: any
): Promise<void> {
  try {
    const fileHash = await computeFileHash(filePath);
    const cacheKey = getCacheKey(fileHash, providerId);
    const index = loadCacheIndex();
    
    index.entries[cacheKey] = {
      fileHash,
      providerId,
      createdAt: new Date().toISOString(),
      result,
    };
    
    saveCacheIndex(index);
    console.log(`Cached transcription for ${cacheKey}`);
  } catch (error) {
    console.error('Cache store error:', error);
  }
}

// Clear the cache
export function clearCache(): void {
  saveCacheIndex({ entries: {} });
  console.log('Cache cleared');
}

// Get cache stats
export function getCacheStats(): { entryCount: number; entries: Array<{ key: string; createdAt: string }> } {
  const index = loadCacheIndex();
  const entries = Object.entries(index.entries).map(([key, entry]) => ({
    key,
    createdAt: entry.createdAt,
  }));
  
  return {
    entryCount: entries.length,
    entries,
  };
}

// Remove cache entries for a specific file
export async function removeCacheForFile(filePath: string): Promise<number> {
  try {
    const fileHash = await computeFileHash(filePath);
    const index = loadCacheIndex();
    let removedCount = 0;
    
    // Find and remove all entries with this file hash
    for (const key of Object.keys(index.entries)) {
      if (key.startsWith(fileHash)) {
        delete index.entries[key];
        removedCount++;
      }
    }
    
    if (removedCount > 0) {
      saveCacheIndex(index);
      console.log(`Removed ${removedCount} cache entries for file hash ${fileHash}`);
    }
    
    return removedCount;
  } catch (error) {
    console.error('Cache removal error:', error);
    return 0;
  }
}
