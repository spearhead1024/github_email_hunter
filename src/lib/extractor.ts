import {
  GitHubError,
  getLastRateLimit,
  listPublicEvents,
  listRepoCommits,
  listUserRepos,
  type RepoSummary,
} from './github';
import { aggregateEmails } from './filter';
import type { ExtractionResult, RawCommit, ScanLevel } from './types';

const DEEP_REPO_LIMIT = 15;
const QUICK_MIN_PERSONAL = 1;

export async function extractEmails(
  username: string,
  level: ScanLevel,
): Promise<ExtractionResult> {
  const warnings: string[] = [];
  const commits: RawCommit[] = [];
  let reposScanned = 0;

  // ---- Strategy 1: public events feed (1 API call, ~90 days) ----
  try {
    const events = await listPublicEvents(username);
    for (const ev of events) {
      if (ev.type !== 'PushEvent' || !ev.payload.commits) continue;
      const repoFullName = ev.repo.name;
      const [owner, repo] = repoFullName.split('/');
      if (!owner || !repo) continue;
      for (const c of ev.payload.commits) {
        if (!c.author?.email) continue;
        commits.push({
          email: c.author.email,
          name: c.author.name,
          repo: repoFullName,
          sha: c.sha,
          url: `https://github.com/${owner}/${repo}/commit/${c.sha}`,
        });
      }
    }
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) {
      throw new Error(`User "${username}" not found.`);
    }
    warnings.push(`Events feed failed: ${(e as Error).message}`);
  }

  const quickAggregate = aggregateEmails(commits);
  const personalCount = quickAggregate.filter((x) => x.classification === 'personal').length;
  const needsDeep = level === 'deep' || personalCount < QUICK_MIN_PERSONAL;

  // ---- Strategy 2: scan top-N owned repos for commits authored by user ----
  if (needsDeep) {
    let repos: RepoSummary[] = [];
    try {
      repos = await listUserRepos(username);
    } catch (e) {
      warnings.push(`Repo list failed: ${(e as Error).message}`);
    }

    const targets = repos
      .filter((r) => !r.fork && !r.private && r.size > 0)
      .slice(0, DEEP_REPO_LIMIT);

    for (const repo of targets) {
      try {
        const repoCommits = await listRepoCommits(username, repo.name, username);
        reposScanned += 1;
        for (const c of repoCommits) {
          // Confirm GitHub login matches; skip if not (defensive — shouldn't happen with ?author=)
          if (c.author && c.author.login.toLowerCase() !== username.toLowerCase()) continue;
          const author = c.commit.author;
          if (!author?.email) continue;
          commits.push({
            email: author.email,
            name: author.name,
            repo: repo.full_name,
            sha: c.sha,
            url: c.html_url,
            date: author.date,
          });
        }
      } catch (e) {
        if (e instanceof GitHubError && e.status === 409) continue; // empty repo
        warnings.push(`${repo.full_name}: ${(e as Error).message}`);
        // If we hit a rate limit, stop scanning further repos
        if (e instanceof GitHubError && e.status === 403) break;
      }
    }
  }

  const emails = aggregateEmails(commits);

  return {
    username,
    emails,
    scannedAt: Date.now(),
    scanLevel: needsDeep ? 'deep' : 'quick',
    reposScanned,
    commitsExamined: commits.length,
    rateLimit: getLastRateLimit() ?? undefined,
    warnings,
  };
}
