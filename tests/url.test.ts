import { describe, expect, it } from 'vitest';
import { detectProfileUsername, parseGitHubProfile } from '../src/lib/url';

describe('parseGitHubProfile', () => {
  it.each([
    ['https://github.com/torvalds', 'torvalds'],
    ['http://github.com/torvalds', 'torvalds'],
    ['github.com/torvalds', 'torvalds'],
    ['github.com/torvalds/', 'torvalds'],
    ['github.com/torvalds/linux', 'torvalds'],
    ['torvalds', 'torvalds'],
    ['  torvalds  ', 'torvalds'],
    ['octo-cat-99', 'octo-cat-99'],
  ])('parses %s -> %s', (input, expected) => {
    expect(parseGitHubProfile(input)).toBe(expected);
  });

  it.each([
    '',
    'github.com/',
    'github.com/settings',
    'github.com/orgs',
    'github.com/marketplace',
    '-leading-dash',
    'trailing-dash-',
    'has space',
    'has--double',
    'a'.repeat(40),
  ])('rejects %s', (input) => {
    expect(parseGitHubProfile(input)).toBe(null);
  });
});

describe('detectProfileUsername', () => {
  it('returns username only on single-segment paths', () => {
    expect(detectProfileUsername('https://github.com/torvalds')).toBe('torvalds');
    expect(detectProfileUsername('https://github.com/torvalds/linux')).toBe(null);
    expect(detectProfileUsername('https://github.com/settings')).toBe(null);
    expect(detectProfileUsername('https://example.com/torvalds')).toBe(null);
  });
});
