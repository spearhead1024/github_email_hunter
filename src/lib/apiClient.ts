import { GitHubError } from './github';
import type { RateBucket } from './crawlTypes';
import { getTokenPool } from './tokens';

const API_BASE = 'https://api.github.com';

interface PoolFetchOptions extends RequestInit {
  bucket: RateBucket;
  signal?: AbortSignal;
}

/**
 * Fetch wrapper that pulls a token from the pool, attaches it, updates pool
 * state from rate-limit headers, and throws GitHubError on non-2xx.
 */
export async function poolFetch<T>(path: string, opts: PoolFetchOptions): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const pool = await getTokenPool();
  const lease = await pool.acquire(opts.bucket, opts.signal);
  const headers = new Headers(opts.headers);
  headers.set('Accept', 'application/vnd.github+json');
  headers.set('X-GitHub-Api-Version', '2022-11-28');
  headers.set('Authorization', `Bearer ${lease.secret}`);

  let res: Response;
  try {
    res = await fetch(url, { ...opts, headers });
  } catch (e) {
    pool.release(lease, new Headers(), 0);
    throw e;
  }
  pool.release(lease, res.headers, res.status);

  if (!res.ok) {
    let message = `GitHub API ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      /* ignore */
    }
    throw new GitHubError(message, res.status);
  }
  return (await res.json()) as T;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; type?: string; path?: string[] }>;
}

export async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const body = JSON.stringify({ query, variables });
  const result = await poolFetch<GraphQLResponse<T>>('/graphql', {
    method: 'POST',
    body,
    bucket: 'graphql',
    signal,
    headers: { 'Content-Type': 'application/json' },
  });
  if (result.errors && result.errors.length > 0) {
    throw new Error(`GraphQL: ${result.errors.map((e) => e.message).join('; ')}`);
  }
  if (!result.data) throw new Error('GraphQL: empty response');
  return result.data;
}
