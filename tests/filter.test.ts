import { describe, expect, it } from 'vitest';
import { aggregateEmails, classifyEmail, isValidEmail } from '../src/lib/filter';
import type { RawCommit } from '../src/lib/types';

describe('isValidEmail', () => {
  it.each([
    ['foo@bar.com', true],
    ['a.b+tag@example.co.uk', true],
    ['', false],
    ['nope', false],
    ['no@host', false],
    ['has space@x.com', false],
  ])('%s -> %s', (input, expected) => {
    expect(isValidEmail(input)).toBe(expected);
  });
});

describe('classifyEmail', () => {
  it.each([
    ['alice@example.com', 'personal'],
    ['Alice@Example.com', 'personal'],
    ['12345+alice@users.noreply.github.com', 'noreply'],
    ['alice@users.noreply.github.com', 'noreply'],
    ['noreply@github.com', 'noreply'],
    ['no-reply@somewhere.com', 'noreply'],
    ['actions@github.com', 'bot'],
    ['github-actions[bot]@users.noreply.github.com', 'bot'],
    ['dependabot[bot]@users.noreply.github.com', 'bot'],
    ['renovate[bot]@users.noreply.github.com', 'bot'],
    ['not-an-email', 'unknown'],
  ] as const)('%s -> %s', (input, expected) => {
    expect(classifyEmail(input)).toBe(expected);
  });
});

describe('aggregateEmails', () => {
  const sample = (email: string, sha: string, repo = 'u/r'): RawCommit => ({
    email,
    name: 'Alice',
    repo,
    sha,
    url: `https://github.com/${repo}/commit/${sha}`,
  });

  it('counts and sorts personal emails by frequency', () => {
    const result = aggregateEmails([
      sample('alice@example.com', 'a'),
      sample('alice@example.com', 'b'),
      sample('old@example.com', 'c'),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]!.email).toBe('alice@example.com');
    expect(result[0]!.count).toBe(2);
    expect(result[1]!.email).toBe('old@example.com');
  });

  it('places personal before noreply before bot', () => {
    const result = aggregateEmails([
      sample('actions@github.com', 'a'),
      sample('alice@users.noreply.github.com', 'b'),
      sample('alice@example.com', 'c'),
    ]);
    expect(result.map((e) => e.classification)).toEqual(['personal', 'noreply', 'bot']);
  });

  it('lowercases and merges case variants', () => {
    const result = aggregateEmails([
      sample('Alice@Example.com', 'a'),
      sample('alice@example.com', 'b'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.email).toBe('alice@example.com');
    expect(result[0]!.count).toBe(2);
  });

  it('limits sources per email', () => {
    const commits = Array.from({ length: 10 }, (_, i) =>
      sample('alice@example.com', `sha${i}`),
    );
    const result = aggregateEmails(commits, 3);
    expect(result[0]!.sources).toHaveLength(3);
    expect(result[0]!.count).toBe(10);
  });

  it('drops invalid emails', () => {
    const result = aggregateEmails([
      sample('not-an-email', 'a'),
      sample('alice@example.com', 'b'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.email).toBe('alice@example.com');
  });
});
