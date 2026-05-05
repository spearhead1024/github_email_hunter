import { getPat } from './storage';
import type { RateLimitInfo } from './types';

const API_BASE = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimit?: RateLimitInfo,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

let lastRateLimit: RateLimitInfo | null = null;

export function getLastRateLimit(): RateLimitInfo | null {
  return lastRateLimit;
}

function parseRateLimit(headers: Headers): RateLimitInfo | undefined {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (!limit || !remaining || !reset) return undefined;
  return {
    limit: Number(limit),
    remaining: Number(remaining),
    reset: Number(reset) * 1000,
  };
}

async function githubFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const pat = await getPat();
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/vnd.github+json');
  headers.set('X-GitHub-Api-Version', '2022-11-28');
  if (pat) headers.set('Authorization', `Bearer ${pat}`);

  const res = await fetch(url, { ...init, headers });
  const rl = parseRateLimit(res.headers);
  if (rl) lastRateLimit = rl;

  if (!res.ok) {
    let message = `GitHub API ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      /* ignore */
    }
    if (res.status === 403 && rl?.remaining === 0) {
      const resetIn = Math.max(0, Math.round((rl.reset - Date.now()) / 1000));
      message = `Rate limit exceeded. Resets in ~${resetIn}s. Add a Personal Access Token in extension options to raise the limit.`;
    }
    throw new GitHubError(message, res.status, rl);
  }
  return (await res.json()) as T;
}

// ---- Endpoint shapes (only fields we use) ----

export interface PublicEvent {
  type: string;
  repo: { name: string };
  payload: {
    commits?: Array<{
      sha: string;
      author: { name: string; email: string };
      message?: string;
    }>;
  };
}

export interface RepoSummary {
  name: string;
  full_name: string;
  fork: boolean;
  private: boolean;
  pushed_at: string | null;
  size: number;
  default_branch: string;
}

export interface CommitSummary {
  sha: string;
  html_url: string;
  commit: {
    author: { name: string; email: string; date: string } | null;
    committer: { name: string; email: string; date: string } | null;
  };
  author: { login: string } | null;
  committer: { login: string } | null;
}

// ---- API methods ----

export function listPublicEvents(username: string): Promise<PublicEvent[]> {
  return githubFetch<PublicEvent[]>(
    `/users/${encodeURIComponent(username)}/events/public?per_page=100`,
  );
}

export function listUserRepos(
  username: string,
  perPage = 100,
): Promise<RepoSummary[]> {
  return githubFetch<RepoSummary[]>(
    `/users/${encodeURIComponent(username)}/repos?type=owner&sort=pushed&per_page=${perPage}`,
  );
}

export function listRepoCommits(
  owner: string,
  repo: string,
  author: string,
  perPage = 30,
): Promise<CommitSummary[]> {
  const path =
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits` +
    `?author=${encodeURIComponent(author)}&per_page=${perPage}`;
  return githubFetch<CommitSummary[]>(path);
}
