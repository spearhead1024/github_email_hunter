import { describe, expect, it } from 'vitest';
import {
  addDays,
  extractCreatedRange,
  isAtomicRange,
  midpointDate,
  parseSearchInput,
  withCreatedRange,
} from '../src/lib/searchQuery';

describe('parseSearchInput', () => {
  it('parses a github search URL', () => {
    const r = parseSearchInput(
      'https://github.com/search?q=location%3APoland&type=Users&ref=advsearch&l=&l=&s=&o=desc',
    );
    expect(r?.query).toBe('location:Poland');
    expect(r?.rawUrl).toContain('github.com/search');
  });

  it('accepts a bare query', () => {
    const r = parseSearchInput('location:Warsaw language:Rust');
    expect(r?.query).toBe('location:Warsaw language:Rust');
    expect(r?.rawUrl).toContain('q=');
  });

  it('rejects empty input and URLs without q', () => {
    expect(parseSearchInput('')).toBe(null);
    expect(parseSearchInput('https://github.com/search?type=Users')).toBe(null);
  });
});

describe('withCreatedRange', () => {
  it('adds created range when none exists', () => {
    expect(withCreatedRange('location:Poland', '2020-01-01', '2020-12-31')).toBe(
      'location:Poland created:2020-01-01..2020-12-31',
    );
  });
  it('replaces existing created qualifier', () => {
    expect(withCreatedRange('location:Poland created:>=2010', '2020-01-01', '2020-12-31')).toBe(
      'location:Poland created:2020-01-01..2020-12-31',
    );
  });
});

describe('extractCreatedRange', () => {
  it.each([
    ['location:Poland created:2020-01-01..2020-12-31', { start: '2020-01-01', end: '2020-12-31' }],
    ['created:>=2020-01-01', { start: '2020-01-01', end: '*' }],
    ['created:<=2020-12-31', { start: '*', end: '2020-12-31' }],
    ['no qualifier', null],
  ] as const)('parses %s', (input, expected) => {
    expect(extractCreatedRange(input)).toEqual(expected);
  });
});

describe('midpointDate', () => {
  it('returns the midpoint date', () => {
    const m = midpointDate('2020-01-01', '2020-12-31');
    expect(m).toMatch(/^2020-/);
  });
  it('handles equal start and end', () => {
    expect(midpointDate('2020-06-01', '2020-06-01')).toBe('2020-06-01');
  });
});

describe('addDays', () => {
  it('advances a date', () => {
    expect(addDays('2020-01-01', 1)).toBe('2020-01-02');
    expect(addDays('2020-12-31', 1)).toBe('2021-01-01');
  });
});

describe('isAtomicRange', () => {
  it('detects single-day ranges', () => {
    expect(isAtomicRange('2020-01-01', '2020-01-01')).toBe(true);
    expect(isAtomicRange('2020-01-01', '2020-01-02')).toBe(false);
  });
});
