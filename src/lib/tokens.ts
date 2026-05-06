import type { BucketState, RateBucket, TokenLease } from './crawlTypes';
import { listTokensWithSecrets, type TokenWithSecret } from './storage';

interface TokenRuntime {
  meta: TokenWithSecret;
  buckets: Record<RateBucket, BucketState>;
  inFlight: number;
  failures: number;
}

function newBucket(): BucketState {
  return { remaining: Infinity, limit: Infinity, reset: 0, cooldownUntil: 0 };
}

/**
 * Per-bucket *capacity* is enforced per OWNER (not per token), because GitHub
 * rate-limits per authenticated user. Multiple PATs from the same account share
 * the same bucket. We therefore track shared state keyed by `${owner}:${bucket}`.
 */
class TokenPool {
  private tokens: TokenRuntime[] = [];
  private sharedState = new Map<string, BucketState>();
  private waitQueue: Array<{
    bucket: RateBucket;
    resolve: (lease: TokenLease) => void;
    reject: (err: Error) => void;
  }> = [];

  async load(): Promise<void> {
    this.loadFromList(await listTokensWithSecrets());
  }

  loadFromList(list: TokenWithSecret[]): void {
    this.tokens = list.map((t) => ({
      meta: t,
      buckets: { core: newBucket(), search: newBucket(), graphql: newBucket() },
      inFlight: 0,
      failures: 0,
    }));
  }

  size(): number {
    return this.tokens.length;
  }

  ownerCount(): number {
    return new Set(this.tokens.map((t) => t.meta.owner)).size;
  }

  private bucketKey(owner: string, bucket: RateBucket): string {
    return `${owner}:${bucket}`;
  }

  private getShared(owner: string, bucket: RateBucket): BucketState {
    const key = this.bucketKey(owner, bucket);
    let s = this.sharedState.get(key);
    if (!s) {
      s = newBucket();
      this.sharedState.set(key, s);
    }
    return s;
  }

  /** Returns a usable token for `bucket` or rejects if pool is empty. */
  async acquire(bucket: RateBucket, signal?: AbortSignal): Promise<TokenLease> {
    if (this.tokens.length === 0) {
      throw new Error('No tokens configured. Add a Personal Access Token in Options.');
    }
    while (true) {
      if (signal?.aborted) throw new Error('aborted');
      const candidate = this.pickAvailable(bucket);
      if (candidate) {
        candidate.inFlight += 1;
        return {
          id: candidate.meta.id,
          secret: candidate.meta.secret,
          bucketKey: this.bucketKey(candidate.meta.owner, bucket),
        };
      }
      // Sleep until earliest bucket reset / cooldown.
      const wait = this.timeUntilNextAvailable(bucket);
      await sleep(Math.min(wait, 5000), signal);
    }
  }

  release(lease: TokenLease, headers: Headers, status: number): void {
    const t = this.tokens.find((x) => x.meta.id === lease.id);
    if (!t) return;
    t.inFlight = Math.max(0, t.inFlight - 1);
    const [, bucketName] = lease.bucketKey.split(':');
    const bucket = (bucketName ?? 'core') as RateBucket;
    const shared = this.sharedState.get(lease.bucketKey) ?? newBucket();

    const limit = headers.get('x-ratelimit-limit');
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    if (limit) shared.limit = Number(limit);
    if (remaining) shared.remaining = Number(remaining);
    if (reset) shared.reset = Number(reset) * 1000;

    if (status === 403 || status === 429) {
      // Secondary rate limit / abuse detection. Apply Retry-After or 60s default.
      const retryAfter = headers.get('retry-after');
      const cooldownMs = retryAfter ? Number(retryAfter) * 1000 : 60_000;
      shared.cooldownUntil = Date.now() + cooldownMs;
      t.failures += 1;
    } else {
      t.failures = 0;
    }

    this.sharedState.set(lease.bucketKey, shared);
    // also mirror into the per-token-bucket view (for UI)
    t.buckets[bucket] = { ...shared };
  }

  private pickAvailable(bucket: RateBucket): TokenRuntime | null {
    const now = Date.now();
    let best: TokenRuntime | null = null;
    let bestRemaining = -1;
    for (const t of this.tokens) {
      const shared = this.getShared(t.meta.owner, bucket);
      if (shared.cooldownUntil > now) continue;
      if (shared.reset > 0 && shared.reset > now && shared.remaining <= 0) continue;
      if (shared.remaining > bestRemaining) {
        bestRemaining = shared.remaining;
        best = t;
      }
    }
    return best;
  }

  private timeUntilNextAvailable(bucket: RateBucket): number {
    const now = Date.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const t of this.tokens) {
      const shared = this.getShared(t.meta.owner, bucket);
      const cd = shared.cooldownUntil > now ? shared.cooldownUntil : 0;
      const reset =
        shared.reset > now && shared.remaining <= 0 ? shared.reset : 0;
      const wait = Math.max(cd, reset);
      if (wait > 0 && wait < earliest) earliest = wait;
      if (wait === 0) return 0;
    }
    if (!Number.isFinite(earliest)) return 1000;
    return Math.max(0, earliest - now);
  }

  /** Snapshot for UI/diagnostics. */
  snapshot() {
    return {
      tokenCount: this.tokens.length,
      ownerCount: this.ownerCount(),
      buckets: [...this.sharedState.entries()].map(([key, s]) => ({ key, ...s })),
    };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(t);
      reject(new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort);
  });
}

let pool: TokenPool | null = null;

export async function getTokenPool(): Promise<TokenPool> {
  if (!pool) {
    pool = new TokenPool();
    await pool.load();
  }
  return pool;
}

/** Force reload after Options page changes. */
export async function reloadTokenPool(): Promise<void> {
  pool = new TokenPool();
  await pool.load();
}

/**
 * Pre-load the pool from a token list passed in-process (used by offscreen
 * document where chrome.storage is unavailable — tokens are supplied by the
 * background SW instead).
 */
export function setTokenPoolFromList(list: TokenWithSecret[]): void {
  pool = new TokenPool();
  pool.loadFromList(list);
}

export type { TokenPool };
