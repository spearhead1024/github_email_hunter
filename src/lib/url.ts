/** GitHub paths that look like a username segment but aren't users. */
const RESERVED = new Set([
  'about',
  'account',
  'apps',
  'codespaces',
  'collections',
  'contact',
  'customer-stories',
  'dashboard',
  'discussions',
  'enterprise',
  'events',
  'explore',
  'features',
  'gist',
  'gists',
  'github',
  'github-copilot',
  'home',
  'issues',
  'login',
  'logout',
  'marketplace',
  'mobile',
  'new',
  'notifications',
  'open-source',
  'orgs',
  'organizations',
  'pricing',
  'pulls',
  'readme',
  'search',
  'security',
  'sessions',
  'settings',
  'signup',
  'site',
  'sponsors',
  'stars',
  'team',
  'teams',
  'topics',
  'trending',
  'watching',
]);

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

/**
 * Parse a GitHub profile URL or bare username. Returns the username, or null.
 * Accepts:
 *   - https://github.com/foo
 *   - github.com/foo
 *   - foo
 */
export function parseGitHubProfile(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  try {
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withProto);
    if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length === 0) return null;
      candidate = segments[0]!;
    }
  } catch {
    // Not a URL — treat as bare username
  }

  if (!USERNAME_RE.test(candidate)) return null;
  if (RESERVED.has(candidate.toLowerCase())) return null;
  return candidate;
}

/**
 * Detect whether a given URL is a profile page (single-segment path).
 * Used by the content script to decide whether to inject the UI.
 */
export function detectProfileUsername(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.hostname !== 'github.com') return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 1) return null;
    return parseGitHubProfile(segments[0]!);
  } catch {
    return null;
  }
}
