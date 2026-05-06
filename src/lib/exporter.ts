import type { Field, JobRecord } from './crawlTypes';
import { iterateCandidatesAll, iterateProfiles } from './db';

const HEADERS: Record<Field | 'login', string> = {
  login: 'login',
  full_name: 'full_name',
  emails: 'emails',
  created_at: 'created_at',
  last_commit_date: 'last_commit_date',
};

/**
 * Build a CSV string for a job. Streams from IndexedDB so memory stays bounded
 * even at 100k rows (each row is small). Returns a Blob ready for download.
 */
export async function buildCsv(job: JobRecord): Promise<Blob> {
  const cols: Array<Field | 'login'> = ['login'];
  for (const f of job.fields) cols.push(f);

  const wantsEnrichment =
    job.fields.includes('emails') || job.fields.includes('last_commit_date');

  const lines: string[] = [];
  lines.push(cols.map((c) => HEADERS[c]).join(','));

  const iterator = wantsEnrichment ? iterateProfiles(job.id) : iterateCandidatesAll(job.id);
  for await (const row of iterator) {
    const cells: string[] = [];
    for (const c of cols) {
      cells.push(csvCell(formatCell(c, row as unknown as Record<string, unknown>, job.fields)));
    }
    lines.push(cells.join(','));
  }
  // Add UTF-8 BOM so Excel auto-detects encoding correctly.
  return new Blob(['﻿', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

function formatCell(
  col: Field | 'login',
  row: Record<string, unknown>,
  selected: Field[],
): string {
  switch (col) {
    case 'login':
      return String(row['login'] ?? '');
    case 'full_name':
      return String(row['name'] ?? '');
    case 'created_at':
      return String(row['createdAt'] ?? '');
    case 'emails': {
      const arr = (row['emails'] as string[] | undefined) ?? [];
      return arr.join(';');
    }
    case 'last_commit_date': {
      const v = row['lastCommitDate'];
      if (typeof v === 'string') return v;
      // Candidate row (no enrichment): fall back to empty.
      void selected;
      return '';
    }
  }
}

function csvCell(value: string): string {
  if (value === '') return '';
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export interface ExportResult {
  filename: string;
  bytes: number;
}

export function csvFilename(job: JobRecord): string {
  const stamp = new Date(job.updatedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeQuery = job.query.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'crawl';
  return `gh-emails_${safeQuery}_${stamp}.csv`;
}

// Convert a Blob to a base64 data URL without FileReader (works in SW contexts).
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}
