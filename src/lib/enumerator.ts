import { gql } from './apiClient';
import type { CandidateRecord, Field, JobRecord, ShardRecord } from './crawlTypes';
import { putCandidatesBulk, putShard, getShards, patchJob } from './db';
import {
  addDays,
  extractCreatedRange,
  formatISODate,
  midpointDate,
  withCreatedRange,
} from './searchQuery';

const SEARCH_HARD_CAP = 1000;
const PAGE_SIZE = 100;
const GITHUB_EPOCH = '2008-01-01';

// GraphQL: search users + minimal fields. `name` and `createdAt` are free.
const SEARCH_QUERY = `
query Enumerate($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: USER, first: $first, after: $after) {
    userCount
    pageInfo { endCursor hasNextPage }
    nodes {
      __typename
      ... on User { login name createdAt }
    }
  }
}
`;

interface SearchResp {
  search: {
    userCount: number;
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
    nodes: Array<
      | { __typename: 'User'; login: string; name: string | null; createdAt: string }
      | { __typename: string }
    >;
  };
}

interface EnumerationOptions {
  signal?: AbortSignal;
  onProgress?: (counts: { discovered: number; estimatedTotal: number }) => void;
}

/**
 * Drive enumeration to completion (or until `limit` users discovered).
 *
 * Strategy:
 *  - Each shard wraps the user's query plus a `created:` range.
 *  - Initial shard: user's full date range (or GitHub epoch → today).
 *  - For any shard with userCount > 1000, bisect by createdAt and re-enqueue.
 *  - Pages each ≤1000-result shard, writing candidates as we go.
 *  - All shard state is persisted, so we can resume after a restart.
 */
export async function runEnumeration(
  job: JobRecord,
  opts: EnumerationOptions = {},
): Promise<void> {
  const fields = new Set<Field>(job.fields);
  const wantName = fields.has('full_name');
  const wantCreatedAt = fields.has('created_at');
  const today = formatISODate(new Date());
  const userRange = extractCreatedRange(job.query);
  const initialStart = userRange?.start && userRange.start !== '*' ? userRange.start : GITHUB_EPOCH;
  const initialEnd = userRange?.end && userRange.end !== '*' ? userRange.end : today;

  // Resume: reuse persisted shards if any.
  let shards = await getShards(job.id);
  if (shards.length === 0) {
    const fragment = withCreatedRange(job.query, initialStart, initialEnd);
    const root: ShardRecord = {
      jobId: job.id,
      fragment,
      rangeStart: initialStart,
      rangeEnd: initialEnd,
      status: 'pending',
      count: -1,
      cursor: null,
      yielded: 0,
    };
    await putShard(root);
    shards = [root];
  }

  const queue = shards.filter((s) => s.status !== 'done' && s.status !== 'failed');
  let totalDiscovered = await countAlreadyDiscovered(job);
  let estimatedTotal = job.counts.estimatedTotal;

  const limit = job.limit > 0 ? job.limit : Number.POSITIVE_INFINITY;

  while (queue.length > 0 && totalDiscovered < limit) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const shard = queue.pop()!;

    // Step 1: count peek if unknown.
    if (shard.count < 0) {
      const data = await gql<SearchResp>(
        SEARCH_QUERY,
        { q: shard.fragment, first: 1, after: null },
        opts.signal,
      );
      shard.count = data.search.userCount;
      if (estimatedTotal === 0 && shard === shards[0]) {
        estimatedTotal = shard.count;
        await patchJob(job.id, { counts: { ...job.counts, estimatedTotal } });
      }
      await putShard(shard);
    }

    // Step 2: subdivide if too big.
    if (shard.count > SEARCH_HARD_CAP) {
      const children = bisectShard(shard, job.query);
      if (children.length === 0) {
        // Atomic range still over cap — accept the loss, paginate the 1000 we can get.
        shard.status = 'paginating';
        await putShard(shard);
      } else {
        for (const child of children) {
          await putShard(child);
          queue.push(child);
        }
        shard.status = 'done';
        await putShard(shard);
        continue;
      }
    } else {
      shard.status = 'paginating';
      await putShard(shard);
    }

    // Step 3: paginate.
    let cursor = shard.cursor;
    let pageGuard = 0;
    while (totalDiscovered < limit) {
      if (opts.signal?.aborted) throw new Error('aborted');
      pageGuard += 1;
      if (pageGuard > 12) break; // hard cap: 10 pages × 100 = 1000
      const remainingForLimit = limit === Infinity ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - totalDiscovered);
      const data = await gql<SearchResp>(
        SEARCH_QUERY,
        { q: shard.fragment, first: remainingForLimit, after: cursor },
        opts.signal,
      );
      const candidates: CandidateRecord[] = [];
      for (const n of data.search.nodes) {
        if (n.__typename !== 'User') continue;
        const u = n as { login: string; name: string | null; createdAt: string };
        candidates.push({
          jobId: job.id,
          login: u.login,
          name: wantName ? u.name : null,
          createdAt: wantCreatedAt ? u.createdAt : '',
          status: 'pending',
        });
      }
      await putCandidatesBulk(candidates);
      totalDiscovered += candidates.length;
      shard.yielded += candidates.length;

      if (!data.search.pageInfo.hasNextPage) break;
      cursor = data.search.pageInfo.endCursor;
      shard.cursor = cursor;
      await putShard(shard);

      opts.onProgress?.({ discovered: totalDiscovered, estimatedTotal });
    }

    shard.status = 'done';
    await putShard(shard);
    await patchJob(job.id, {
      counts: { ...job.counts, discovered: totalDiscovered, estimatedTotal },
    });
  }
}

function bisectShard(shard: ShardRecord, baseQuery: string): ShardRecord[] {
  const { rangeStart, rangeEnd, jobId } = shard;
  if (rangeStart === rangeEnd) return []; // atomic — cannot bisect further
  const mid = midpointDate(rangeStart, rangeEnd);
  if (mid === rangeStart || mid === rangeEnd) return [];

  const left: ShardRecord = {
    jobId,
    fragment: withCreatedRange(baseQuery, rangeStart, mid),
    rangeStart,
    rangeEnd: mid,
    status: 'pending',
    count: -1,
    cursor: null,
    yielded: 0,
  };
  const right: ShardRecord = {
    jobId,
    fragment: withCreatedRange(baseQuery, addDays(mid, 1), rangeEnd),
    rangeStart: addDays(mid, 1),
    rangeEnd,
    status: 'pending',
    count: -1,
    cursor: null,
    yielded: 0,
  };
  return [left, right];
}

async function countAlreadyDiscovered(job: JobRecord): Promise<number> {
  // Use job.counts.discovered if non-zero (post-restart), else fall back to 0.
  return job.counts.discovered ?? 0;
}
