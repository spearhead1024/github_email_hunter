export type Field = 'full_name' | 'emails' | 'created_at' | 'last_commit_date';

export type JobStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type JobPhase = 'enumerate' | 'enrich' | 'export' | 'done';

export interface JobRecord {
  id: string;
  query: string;
  rawSearchUrl: string;
  limit: number; // 0 means "all"
  fields: Field[];
  fallbackSearchCommits: boolean;
  status: JobStatus;
  phase: JobPhase;
  createdAt: number;
  updatedAt: number;
  counts: {
    estimatedTotal: number; // best-effort from initial count
    discovered: number; // candidates written
    enriched: number; // profiles enriched
    failed: number;
  };
  error?: string;
}

export type ShardStatus = 'pending' | 'paginating' | 'done' | 'failed';

export interface ShardRecord {
  jobId: string;
  fragment: string; // full GraphQL search query string
  /** ISO datetime range covered by this shard (inclusive lower, inclusive upper). */
  rangeStart: string;
  rangeEnd: string;
  status: ShardStatus;
  count: number; // -1 = unknown
  cursor: string | null; // GraphQL pagination cursor
  yielded: number; // # users emitted from this shard so far
  error?: string;
}

export type CandidateStatus = 'pending' | 'enriched' | 'failed';

export interface CandidateRecord {
  jobId: string;
  login: string;
  name: string | null; // full_name
  createdAt: string; // ISO
  status: CandidateStatus;
  error?: string;
}

export interface ProfileRecord {
  jobId: string;
  login: string;
  name: string | null;
  createdAt: string;
  emails: string[]; // personal emails only (filtered)
  proxyEmails: string[]; // noreply addresses (kept for reference)
  lastCommitDate: string | null; // ISO or null
}

export interface TokenMeta {
  id: string;
  label: string;
  owner: string; // GitHub login as resolved by GET /user
  scopes: string[];
  addedAt: number;
  lastVerifiedAt: number;
}

/** A leased token returned from the pool; release() must be called. */
export interface TokenLease {
  id: string;
  secret: string;
  bucketKey: string; // groups tokens that share quota (owner+bucket)
}

export type RateBucket = 'core' | 'search' | 'graphql';

export interface BucketState {
  remaining: number;
  limit: number;
  reset: number; // ms since epoch
  cooldownUntil: number; // ms since epoch, for secondary-rate-limit backoff
}

// ---- Messaging (crawl) ----

export type CrawlMessage =
  | { type: 'CRAWL_START'; job: Omit<JobRecord, 'createdAt' | 'updatedAt' | 'status' | 'phase' | 'counts'> }
  | { type: 'CRAWL_PAUSE'; jobId: string }
  | { type: 'CRAWL_RESUME'; jobId: string }
  | { type: 'CRAWL_CANCEL'; jobId: string }
  | { type: 'CRAWL_EXPORT'; jobId: string }
  | { type: 'CRAWL_GET_STATE'; jobId: string }
  | { type: 'CRAWL_LIST' }
  | { type: 'CRAWL_TOKEN_VERIFY'; secret: string };

export interface JobState {
  job: JobRecord;
  shardCount: number;
  shardsDone: number;
}
