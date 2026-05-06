import type { TokenMeta } from './crawlTypes';

const TOKENS_META_KEY = 'tokens_meta';
const TOKEN_SECRET_PREFIX = 'token_secret:';

// Legacy single-PAT key, retained for one-time migration.
const LEGACY_PAT_KEY = 'github_pat';

export interface TokenWithSecret extends TokenMeta {
  secret: string;
}

export async function listTokens(): Promise<TokenMeta[]> {
  const result = await chrome.storage.local.get(TOKENS_META_KEY);
  const list = result[TOKENS_META_KEY];
  return Array.isArray(list) ? (list as TokenMeta[]) : [];
}

export async function getTokenSecret(id: string): Promise<string | null> {
  const key = TOKEN_SECRET_PREFIX + id;
  const result = await chrome.storage.local.get(key);
  const v = result[key];
  return typeof v === 'string' ? v : null;
}

export async function listTokensWithSecrets(): Promise<TokenWithSecret[]> {
  const meta = await listTokens();
  const keys = meta.map((m) => TOKEN_SECRET_PREFIX + m.id);
  if (keys.length === 0) return [];
  const result = await chrome.storage.local.get(keys);
  return meta
    .map((m) => {
      const secret = result[TOKEN_SECRET_PREFIX + m.id];
      if (typeof secret !== 'string') return null;
      return { ...m, secret };
    })
    .filter((x): x is TokenWithSecret => x !== null);
}

export async function addToken(meta: TokenMeta, secret: string): Promise<void> {
  const all = await listTokens();
  const existing = all.findIndex((t) => t.id === meta.id);
  if (existing >= 0) all[existing] = meta;
  else all.push(meta);
  await chrome.storage.local.set({
    [TOKENS_META_KEY]: all,
    [TOKEN_SECRET_PREFIX + meta.id]: secret,
  });
}

export async function removeToken(id: string): Promise<void> {
  const all = await listTokens();
  const next = all.filter((t) => t.id !== id);
  await chrome.storage.local.set({ [TOKENS_META_KEY]: next });
  await chrome.storage.local.remove(TOKEN_SECRET_PREFIX + id);
}

/**
 * Backwards-compat shim used by single-profile lookups. Returns the first
 * available token's secret (preferring the longest-remaining bucket caller
 * should use the token pool, but this keeps the existing extractor working).
 */
export async function getDefaultSecret(): Promise<string | null> {
  const tokens = await listTokensWithSecrets();
  if (tokens.length > 0) return tokens[0]!.secret;
  // Migrate legacy single-PAT if present.
  const legacy = await chrome.storage.local.get(LEGACY_PAT_KEY);
  const v = legacy[LEGACY_PAT_KEY];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ---- Legacy compatibility (existing extractor imports these) ----

export async function getPat(): Promise<string | null> {
  return getDefaultSecret();
}

/** Adds a "legacy" token via the new system. Used only during migration. */
export async function setPat(pat: string | null): Promise<void> {
  if (pat === null || pat === '') {
    await chrome.storage.local.remove(LEGACY_PAT_KEY);
    return;
  }
  await chrome.storage.local.set({ [LEGACY_PAT_KEY]: pat });
}
