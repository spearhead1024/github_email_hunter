import type { EmailClassification, ExtractedEmail, RawCommit } from './types';

const NOREPLY_PATTERNS: RegExp[] = [
  /@users\.noreply\.github\.com$/i,
  /^noreply@github\.com$/i,
  /^no-?reply@/i,
];

const BOT_PATTERNS: RegExp[] = [
  /^actions@github\.com$/i,
  /^github-actions(\[bot\])?@/i,
  /\[bot\]@/i,
  /^dependabot(\[bot\])?@/i,
  /^renovate(\[bot\])?@/i,
  /^pre-commit-ci(\[bot\])?@/i,
  /^semantic-release(\[bot\])?@/i,
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

export function classifyEmail(email: string): EmailClassification {
  const e = email.trim().toLowerCase();
  if (!isValidEmail(e)) return 'unknown';
  // Check bot first: many bot addresses are also at users.noreply.github.com,
  // and "bot" is the more useful classification for the user.
  if (BOT_PATTERNS.some((p) => p.test(e))) return 'bot';
  if (NOREPLY_PATTERNS.some((p) => p.test(e))) return 'noreply';
  return 'personal';
}

/**
 * Group raw commits by email, count frequency, attach up to N source commits.
 * Result is sorted: personal first (by count desc), then noreply, then bot/unknown.
 */
export function aggregateEmails(
  commits: RawCommit[],
  maxSourcesPerEmail = 5,
): ExtractedEmail[] {
  const map = new Map<string, ExtractedEmail>();

  for (const c of commits) {
    const email = c.email.trim().toLowerCase();
    if (!isValidEmail(email)) continue;

    let entry = map.get(email);
    if (!entry) {
      entry = {
        email,
        name: c.name,
        count: 0,
        classification: classifyEmail(email),
        sources: [],
      };
      map.set(email, entry);
    }
    entry.count += 1;
    if (entry.sources.length < maxSourcesPerEmail) {
      entry.sources.push({ repo: c.repo, sha: c.sha, url: c.url, date: c.date });
    }
    if (!entry.name && c.name) entry.name = c.name;
  }

  const rank: Record<EmailClassification, number> = {
    personal: 0,
    noreply: 1,
    unknown: 2,
    bot: 3,
  };

  return [...map.values()].sort((a, b) => {
    const r = rank[a.classification] - rank[b.classification];
    if (r !== 0) return r;
    return b.count - a.count;
  });
}
