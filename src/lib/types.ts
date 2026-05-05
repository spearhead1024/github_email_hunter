export type EmailClassification = 'personal' | 'noreply' | 'bot' | 'unknown';

export type ScanLevel = 'quick' | 'deep';

export interface CommitSource {
  repo: string;
  sha: string;
  url: string;
  date?: string;
}

export interface ExtractedEmail {
  email: string;
  name?: string;
  count: number;
  classification: EmailClassification;
  sources: CommitSource[];
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
}

export interface ExtractionResult {
  username: string;
  emails: ExtractedEmail[];
  scannedAt: number;
  scanLevel: ScanLevel;
  reposScanned: number;
  commitsExamined: number;
  rateLimit?: RateLimitInfo;
  warnings: string[];
}

export interface RawCommit {
  email: string;
  name?: string;
  repo: string;
  sha: string;
  url: string;
  date?: string;
}

export type Message =
  | { type: 'EXTRACT'; username: string; level: ScanLevel; force?: boolean }
  | { type: 'GET_CACHED'; username: string }
  | { type: 'CLEAR_CACHE' }
  | { type: 'GET_RATE_LIMIT' };

export type MessageResponse<T extends Message['type']> = T extends 'EXTRACT'
  ? { ok: true; data: ExtractionResult } | { ok: false; error: string }
  : T extends 'GET_CACHED'
    ? { ok: true; data: ExtractionResult | null }
    : T extends 'CLEAR_CACHE'
      ? { ok: true }
      : T extends 'GET_RATE_LIMIT'
        ? { ok: true; data: RateLimitInfo | null }
        : never;
