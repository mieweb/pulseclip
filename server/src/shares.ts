import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export interface SharedArtipod {
  tokenHash?: string;
  /** Legacy plaintext token, supported only for links created before token hashing. */
  token?: string;
  artipodId: string;
  createdAt: string;
}

export interface CreatedShare {
  token: string;
  artipodId: string;
  createdAt: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const sharesPath = join(__dirname, '../data/shares.json');

function readShares(): SharedArtipod[] {
  if (!existsSync(sharesPath)) {
    return [];
  }

  try {
    const shares = JSON.parse(readFileSync(sharesPath, 'utf-8'));
    return Array.isArray(shares) ? shares : [];
  } catch (error) {
    console.error('Failed to read share registry:', error);
    return [];
  }
}

function writeShares(shares: SharedArtipod[]): void {
  mkdirSync(dirname(sharesPath), { recursive: true });
  writeFileSync(sharesPath, JSON.stringify(shares, null, 2));
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createShare(artipodId: string): CreatedShare {
  const shares = readShares();
  let token: string;

  do {
    token = randomBytes(16).toString('hex');
  } while (shares.some((share) => share.tokenHash === hashToken(token) || share.token === token));

  const createdAt = new Date().toISOString();
  shares.push({ tokenHash: hashToken(token), artipodId, createdAt });
  writeShares(shares);
  return { token, artipodId, createdAt };
}

export function getSharedArtipod(token: string): SharedArtipod | undefined {
  const tokenHash = hashToken(token);
  return readShares().find((share) => share.tokenHash === tokenHash || share.token === token);
}

export function removeSharesForArtipod(artipodId: string): number {
  const shares = readShares();
  const retainedShares = shares.filter((share) => share.artipodId !== artipodId);
  const removedCount = shares.length - retainedShares.length;

  if (removedCount > 0) {
    writeShares(retainedShares);
  }

  return removedCount;
}