import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '../data');
const DEMOS_FILE = join(DATA_DIR, 'demos.json');

export interface Demo {
  filename: string;
  title: string;
  thumbnail?: string;
  addedAt: string;
}

interface DemosData {
  demos: Demo[];
}

// Ensure data directory exists
function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

// Load demos from file
function loadDemos(): DemosData {
  ensureDataDir();
  if (!existsSync(DEMOS_FILE)) {
    return { demos: [] };
  }
  try {
    const data = readFileSync(DEMOS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { demos: [] };
  }
}

// Save demos to file
function saveDemos(data: DemosData): void {
  ensureDataDir();
  writeFileSync(DEMOS_FILE, JSON.stringify(data, null, 2));
}

// Get all demos
export function getDemos(): Demo[] {
  return loadDemos().demos;
}

// Check if a file is marked as demo
export function isDemo(filename: string): boolean {
  const data = loadDemos();
  return data.demos.some((d) => d.filename === filename);
}

// Add or update a demo
export function addDemo(filename: string, title: string, thumbnail?: string): Demo {
  const data = loadDemos();
  
  // Check if already exists
  const existing = data.demos.find((d) => d.filename === filename);
  if (existing) {
    // Update title and thumbnail
    existing.title = title;
    if (thumbnail !== undefined) {
      existing.thumbnail = thumbnail || undefined;
    }
    saveDemos(data);
    return existing;
  }
  
  const demo: Demo = {
    filename,
    title,
    thumbnail: thumbnail || undefined,
    addedAt: new Date().toISOString(),
  };
  
  data.demos.push(demo);
  saveDemos(data);
  return demo;
}

// Remove a demo
export function removeDemo(filename: string): boolean {
  const data = loadDemos();
  const index = data.demos.findIndex((d) => d.filename === filename);
  
  if (index === -1) {
    return false;
  }
  
  data.demos.splice(index, 1);
  saveDemos(data);
  return true;
}
