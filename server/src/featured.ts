import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../data');
const FEATURED_FILE = join(DATA_DIR, 'featured.json');

export interface FeaturedPulse {
  filename: string;
  title: string;
  thumbnail?: string;
  addedAt: string;
}

interface FeaturedData {
  featured: FeaturedPulse[];
}

// Ensure data directory exists
function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

// Load featured pulses from file
function loadFeatured(): FeaturedData {
  ensureDataDir();
  if (!existsSync(FEATURED_FILE)) {
    return { featured: [] };
  }
  try {
    const data = readFileSync(FEATURED_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    // Handle legacy format with "demos" key
    if (parsed.demos && !parsed.featured) {
      return { featured: parsed.demos };
    }
    return parsed;
  } catch {
    return { featured: [] };
  }
}

// Save featured pulses to file
function saveFeatured(data: FeaturedData): void {
  ensureDataDir();
  writeFileSync(FEATURED_FILE, JSON.stringify(data, null, 2));
}

// Get all featured pulses
export function getFeatured(): FeaturedPulse[] {
  return loadFeatured().featured;
}

// Check if a pulse is marked as featured
export function isFeatured(filename: string): boolean {
  const data = loadFeatured();
  return data.featured.some((p) => p.filename === filename);
}

// Add or update a featured pulse
export function addFeatured(filename: string, title: string, thumbnail?: string): FeaturedPulse {
  const data = loadFeatured();
  
  // Check if already exists
  const existing = data.featured.find((p) => p.filename === filename);
  if (existing) {
    // Update title and thumbnail
    existing.title = title;
    if (thumbnail !== undefined) {
      existing.thumbnail = thumbnail || undefined;
    }
    saveFeatured(data);
    return existing;
  }
  
  const pulse: FeaturedPulse = {
    filename,
    title,
    thumbnail: thumbnail || undefined,
    addedAt: new Date().toISOString(),
  };
  
  data.featured.push(pulse);
  saveFeatured(data);
  return pulse;
}

// Remove a featured pulse
export function removeFeatured(filename: string): boolean {
  const data = loadFeatured();
  const index = data.featured.findIndex((p) => p.filename === filename);
  
  if (index === -1) {
    return false;
  }
  
  data.featured.splice(index, 1);
  saveFeatured(data);
  return true;
}
