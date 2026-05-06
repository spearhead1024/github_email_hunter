/**
 * Parse a GitHub search URL or raw query into the bare query string.
 * Accepts:
 *   - https://github.com/search?q=location%3APoland&type=Users&...
 *   - location:Poland
 */
export function parseSearchInput(input: string): { query: string; rawUrl: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let query: string;
  let rawUrl = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const q = url.searchParams.get('q');
      if (!q) return null;
      query = q;
      rawUrl = url.toString();
    } catch {
      return null;
    }
  } else {
    query = trimmed;
    rawUrl = `https://github.com/search?q=${encodeURIComponent(trimmed)}&type=Users`;
  }
  query = query.trim();
  if (!query) return null;
  return { query, rawUrl };
}

/**
 * Compose a query fragment by adding/replacing the `created:` qualifier.
 * If the user's query already specifies `created:`, we respect it as the outer
 * range and bisect *within* it on first split.
 */
export function withCreatedRange(baseQuery: string, startISO: string, endISO: string): string {
  const stripped = baseQuery.replace(/\bcreated:\S+/gi, '').trim();
  return `${stripped} created:${startISO}..${endISO}`.trim();
}

/** Pull the existing `created:` qualifier from a query, if present. */
export function extractCreatedRange(
  query: string,
): { start: string; end: string } | null {
  const match = query.match(/\bcreated:(\S+)/i);
  if (!match) return null;
  const value = match[1]!;
  // Forms: 2020-01-01..2020-12-31 | >=2020-01-01 | <=2020-12-31 | 2020-01-01
  if (value.includes('..')) {
    const [a, b] = value.split('..');
    if (a && b) return { start: a, end: b };
  }
  if (value.startsWith('>=')) return { start: value.slice(2), end: '*' };
  if (value.startsWith('<=')) return { start: '*', end: value.slice(2) };
  if (value.startsWith('>')) return { start: value.slice(1), end: '*' };
  if (value.startsWith('<')) return { start: '*', end: value.slice(1) };
  return { start: value, end: value };
}

/** Inclusive midpoint of an ISO-date range, returned as YYYY-MM-DD. */
export function midpointDate(startISO: string, endISO: string): string {
  const a = new Date(startISO).getTime();
  const b = new Date(endISO).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return startISO;
  const mid = new Date(Math.floor((a + b) / 2));
  return formatISODate(mid);
}

export function formatISODate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return formatISODate(d);
}

/** Returns true if start equals end (the smallest atomic shard, single day). */
export function isAtomicRange(startISO: string, endISO: string): boolean {
  return startISO === endISO;
}
