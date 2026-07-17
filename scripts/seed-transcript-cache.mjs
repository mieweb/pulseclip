#!/usr/bin/env node
/**
 * Seed a synthetic cached transcription for a media file so the editor can be
 * exercised without a working AssemblyAI key.
 *
 * Usage: node scripts/seed-transcript-cache.mjs <fileMd5> [durationSec]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '../server/cache');
const INDEX = join(CACHE_DIR, 'index.json');

const [fileHash, durationArg] = process.argv.slice(2);
if (!fileHash) {
  console.error('usage: seed-transcript-cache.mjs <fileMd5> [durationSec]');
  process.exit(1);
}
const durationMs = Math.floor((Number(durationArg) || 57.5) * 1000);

// Script with fillers and pauses so filler/silence removal is testable.
const script = `Okay so um today I want to talk about the new pulse clip editor .
Uh basically the idea is that you can edit video like you would edit text .
You know just select the words you don't want and uh delete them .
So like every word has a timestamp from the transcription provider .
Um and when we remove a word we actually remove that slice of the media .
Basically the playback engine skips over the deleted regions seamlessly .
Uh you can also remove silence and um filler words automatically .
Right so that's the demo I hope you uh like it thanks for watching .`;

const tokens = script.split(/\s+/).filter(Boolean);
const words = [];
let t = 800; // lead-in silence
for (const tok of tokens) {
  if (tok === '.') {
    // sentence boundary: longer pause
    t += 1600;
    continue;
  }
  const isFiller = ['um', 'uh', 'basically', 'like', 'you', 'know', 'right', 'so', 'okay'].includes(tok.toLowerCase());
  const len = 120 + tok.length * 45 + (isFiller ? 80 : 0);
  words.push({
    text: tok,
    startMs: t,
    endMs: t + len,
    confidence: 0.9 + Math.random() * 0.09,
    speakerId: 'A',
  });
  t += len + 60 + Math.floor(Math.random() * 120); // small inter-word gap
}
// Scale to fit duration (leave 1.5s tail)
const scale = (durationMs - 1500) / t;
for (const w of words) {
  w.startMs = Math.floor(w.startMs * scale);
  w.endMs = Math.floor(w.endMs * scale);
}

const normalized = {
  durationMs,
  speakers: [{ id: 'A', name: 'Doug' }],
  words,
  segments: [],
};

const result = {
  normalized,
  raw: { synthetic: true, note: 'Seeded by scripts/seed-transcript-cache.mjs for editor testing', words },
};

mkdirSync(CACHE_DIR, { recursive: true });
const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf-8')) : { entries: {} };
index.entries[`${fileHash}-assemblyai`] = {
  fileHash,
  providerId: 'assemblyai',
  createdAt: new Date().toISOString(),
  result,
};
writeFileSync(INDEX, JSON.stringify(index, null, 2));
console.log(`Seeded ${words.length} words (${(durationMs / 1000).toFixed(1)}s) for ${fileHash}-assemblyai`);
