import { poolFetch } from './apiClient';
import { classifyEmail } from './filter';
import { GitHubError } from './github';
import type { CandidateRecord, JobRecord, ProfileRecord } from './crawlTypes';
import {
  getPendingCandidates,
  patchCandidate,
  patchJob,
  putProfile,
} from './db';

interface PublicEvent {
  type: string;
  created_at: string;
  repo: { name: string };
  payload: {
    commits?: Array<{ sha: string; author: { name: string; email: string } }>;
  };
}

interface CommitSearchResp {
  total_count: number;
  items: Array<{
    commit: { author: { name: string; email: string; date: string } };
  }>;
}

interface EnrichmentOptions {
  signal?: AbortSignal;
  onProgress?: (counts: { enriched: number; failed: number }) => void;
  concurrency?: number;
}

/**
 * Enrich every pending candidate. Concurrency = number of effective token
 * buckets (passed in via opts). Per-user cost: 1 events-feed call, plus
 * optionally 1 search-commits call as a fallback.
 */
export async function runEnrichment(
  job: JobRecord,
  opts: EnrichmentOptions = {},
): Promise<void> {
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const wantEmails = job.fields.includes('emails');
  const wantLastCommit = job.fields.includes('last_commit_date');
  if (!wantEmails && !wantLastCommit) return; // nothing to do

  // Load all pending candidates into memory upfront. Cursor-based iteration
  // breaks when async HTTP work runs between yields because the IDB transaction
  // auto-commits while no request is pending.
  const pending = await getPendingCandidates(job.id);
  let idx = 0;
  let enriched = job.counts.enriched ?? 0;
  let failed = job.counts.failed ?? 0;

  const next = (): CandidateRecord | null => pending[idx++] ?? null;

  const workers: Promise<void>[] = [];

  for (let i = 0; i < concurrency; i++) {
    workers.push(
      (async () => {
        while (true) {
          if (opts.signal?.aborted) return;
          const candidate = next();
          if (!candidate) return;
          try {
            const profile = await enrichOne(candidate, job, opts.signal);
            await putProfile(profile);
            await patchCandidate(job.id, candidate.login, { status: 'enriched' });
            enriched += 1;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await patchCandidate(job.id, candidate.login, { status: 'failed', error: msg });
            failed += 1;
            if (e instanceof GitHubError && e.status === 401) throw e;
          } finally {
            if ((enriched + failed) % 25 === 0) {
              await patchJob(job.id, {
                counts: { ...job.counts, enriched, failed },
              });
              opts.onProgress?.({ enriched, failed });
            }
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  await patchJob(job.id, { counts: { ...job.counts, enriched, failed } });
  opts.onProgress?.({ enriched, failed });
}

async function enrichOne(
  candidate: CandidateRecord,
  job: JobRecord,
  signal?: AbortSignal,
): Promise<ProfileRecord> {
  const wantEmails = job.fields.includes('emails');
  const wantLastCommit = job.fields.includes('last_commit_date');

  const emailsSet = new Map<string, string>(); // email -> name
  const proxies = new Set<string>();
  let lastCommitDate: string | null = null;

  // Step 1: events feed (1 Core call).
  let events: PublicEvent[] = [];
  try {
    events = await poolFetch<PublicEvent[]>(
      `/users/${encodeURIComponent(candidate.login)}/events/public?per_page=100`,
      { bucket: 'core', signal },
    );
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) {
      // user removed/renamed — write empty profile rather than failing
    } else {
      throw e;
    }
  }

  for (const ev of events) {
    if (ev.type === 'PushEvent' && ev.payload.commits) {
      if (!lastCommitDate || ev.created_at > lastCommitDate) {
        lastCommitDate = ev.created_at;
      }
      if (wantEmails) {
        for (const c of ev.payload.commits) {
          if (!c.author?.email) continue;
          const e = c.author.email.toLowerCase();
          const cls = classifyEmail(e);
          if (cls === 'personal') emailsSet.set(e, c.author.name ?? '');
          else if (cls === 'noreply') proxies.add(e);
        }
      }
    } else if (
      !lastCommitDate &&
      (ev.type === 'CreateEvent' || ev.type === 'PullRequestEvent')
    ) {
      // weak hint: user is at least active on this date; not a real commit, ignore.
    }
  }

  // Step 2: optional fallback for last_commit_date when events feed yielded nothing.
  if (
    wantLastCommit &&
    job.fallbackSearchCommits &&
    !lastCommitDate
  ) {
    try {
      const r = await poolFetch<CommitSearchResp>(
        `/search/commits?q=${encodeURIComponent('author:' + candidate.login)}&sort=author-date&order=desc&per_page=1`,
        { bucket: 'search', signal },
      );
      if (r.items.length > 0) {
        const item = r.items[0]!;
        lastCommitDate = item.commit.author.date;
        if (wantEmails && item.commit.author.email) {
          const e = item.commit.author.email.toLowerCase();
          const cls = classifyEmail(e);
          if (cls === 'personal') emailsSet.set(e, item.commit.author.name ?? '');
          else if (cls === 'noreply') proxies.add(e);
        }
      }
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422) {
        // search-commits requires preview header sometimes; ignore
      } else if (e instanceof GitHubError && e.status === 403) {
        throw e; // bubble rate-limit so caller can pause
      }
    }
  }

  return {
    jobId: job.id,
    login: candidate.login,
    name: candidate.name,
    createdAt: candidate.createdAt,
    emails: wantEmails ? [...emailsSet.keys()] : [],
    proxyEmails: wantEmails ? [...proxies] : [],
    lastCommitDate: wantLastCommit ? lastCommitDate : null,
  };
}
