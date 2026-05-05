import type { ExtractionResult } from './types';

const CACHE_PREFIX = 'cache:';
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 50;

function key(username: string): string {
  return `${CACHE_PREFIX}${username.toLowerCase()}`;
}

export async function getCached(username: string): Promise<ExtractionResult | null> {
  const k = key(username);
  const result = await chrome.storage.local.get(k);
  const entry = result[k] as ExtractionResult | undefined;
  if (!entry) return null;
  if (Date.now() - entry.scannedAt > TTL_MS) {
    await chrome.storage.local.remove(k);
    return null;
  }
  return entry;
}

export async function setCached(result: ExtractionResult): Promise<void> {
  await chrome.storage.local.set({ [key(result.username)]: result });
  await pruneCache();
}

async function pruneCache(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([k]) => k.startsWith(CACHE_PREFIX))
    .map(([k, v]) => [k, v as ExtractionResult] as const)
    .sort((a, b) => a[1].scannedAt - b[1].scannedAt);

  if (entries.length <= MAX_ENTRIES) return;
  const toRemove = entries.slice(0, entries.length - MAX_ENTRIES).map(([k]) => k);
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
}

export async function clearCache(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}

export async function listCached(): Promise<ExtractionResult[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(CACHE_PREFIX))
    .map(([, v]) => v as ExtractionResult)
    .sort((a, b) => b.scannedAt - a.scannedAt);
}
