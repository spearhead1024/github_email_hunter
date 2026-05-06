import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  CandidateRecord,
  CandidateStatus,
  JobRecord,
  ProfileRecord,
  ShardRecord,
  ShardStatus,
} from './crawlTypes';

interface CrawlDB extends DBSchema {
  jobs: {
    key: string;
    value: JobRecord;
    indexes: { byUpdatedAt: number };
  };
  shards: {
    key: [string, string]; // [jobId, fragment]
    value: ShardRecord;
    indexes: { byJob: string; byJobStatus: [string, ShardStatus] };
  };
  candidates: {
    key: [string, string]; // [jobId, login]
    value: CandidateRecord;
    indexes: { byJob: string; byJobStatus: [string, CandidateStatus] };
  };
  profiles: {
    key: [string, string];
    value: ProfileRecord;
    indexes: { byJob: string };
  };
}

const DB_NAME = 'ghEmailHunter';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<CrawlDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<CrawlDB>> {
  if (!dbPromise) {
    dbPromise = openDB<CrawlDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const jobs = db.createObjectStore('jobs', { keyPath: 'id' });
        jobs.createIndex('byUpdatedAt', 'updatedAt');

        const shards = db.createObjectStore('shards', { keyPath: ['jobId', 'fragment'] });
        shards.createIndex('byJob', 'jobId');
        shards.createIndex('byJobStatus', ['jobId', 'status']);

        const candidates = db.createObjectStore('candidates', { keyPath: ['jobId', 'login'] });
        candidates.createIndex('byJob', 'jobId');
        candidates.createIndex('byJobStatus', ['jobId', 'status']);

        const profiles = db.createObjectStore('profiles', { keyPath: ['jobId', 'login'] });
        profiles.createIndex('byJob', 'jobId');
      },
    });
  }
  return dbPromise;
}

// ---- Jobs ----

export async function putJob(job: JobRecord): Promise<void> {
  const db = await getDB();
  await db.put('jobs', job);
}

export async function getJob(id: string): Promise<JobRecord | undefined> {
  const db = await getDB();
  return db.get('jobs', id);
}

export async function listJobs(): Promise<JobRecord[]> {
  const db = await getDB();
  const all = await db.getAll('jobs');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function patchJob(
  id: string,
  patch: Partial<JobRecord>,
): Promise<JobRecord | undefined> {
  const db = await getDB();
  const tx = db.transaction('jobs', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) return undefined;
  const updated: JobRecord = { ...existing, ...patch, updatedAt: Date.now() };
  await tx.store.put(updated);
  await tx.done;
  return updated;
}

export async function deleteJob(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['jobs', 'shards', 'candidates', 'profiles'], 'readwrite');
  await tx.objectStore('jobs').delete(id);
  for (const store of ['shards', 'candidates', 'profiles'] as const) {
    const idx = tx.objectStore(store).index('byJob');
    let cursor = await idx.openKeyCursor(IDBKeyRange.only(id));
    while (cursor) {
      await tx.objectStore(store).delete(cursor.primaryKey);
      cursor = await cursor.continue();
    }
  }
  await tx.done;
}

// ---- Shards ----

export async function putShard(shard: ShardRecord): Promise<void> {
  const db = await getDB();
  await db.put('shards', shard);
}

export async function getShards(jobId: string): Promise<ShardRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex('shards', 'byJob', jobId);
}

export async function getPendingShards(jobId: string): Promise<ShardRecord[]> {
  const db = await getDB();
  const pending = await db.getAllFromIndex('shards', 'byJobStatus', [jobId, 'pending']);
  const paginating = await db.getAllFromIndex('shards', 'byJobStatus', [jobId, 'paginating']);
  return [...pending, ...paginating];
}

// ---- Candidates ----

export async function putCandidate(c: CandidateRecord): Promise<void> {
  const db = await getDB();
  await db.put('candidates', c);
}

export async function putCandidatesBulk(items: CandidateRecord[]): Promise<void> {
  if (items.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('candidates', 'readwrite');
  await Promise.all(items.map((i) => tx.store.put(i)));
  await tx.done;
}

export async function countCandidates(jobId: string): Promise<number> {
  const db = await getDB();
  return db.countFromIndex('candidates', 'byJob', jobId);
}

// Load all pending candidates at once so callers can do async work between
// records without keeping an IDB transaction open (cursor transactions
// auto-commit if no request is pending, which breaks async enrichment loops).
export async function getPendingCandidates(jobId: string): Promise<CandidateRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex('candidates', 'byJobStatus', [jobId, 'pending']);
}

export async function patchCandidate(
  jobId: string,
  login: string,
  patch: Partial<CandidateRecord>,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('candidates', 'readwrite');
  const existing = await tx.store.get([jobId, login]);
  if (!existing) {
    await tx.done;
    return;
  }
  await tx.store.put({ ...existing, ...patch });
  await tx.done;
}

// ---- Profiles ----

export async function putProfile(p: ProfileRecord): Promise<void> {
  const db = await getDB();
  await db.put('profiles', p);
}

export async function countProfiles(jobId: string): Promise<number> {
  const db = await getDB();
  return db.countFromIndex('profiles', 'byJob', jobId);
}

export async function* iterateProfiles(jobId: string): AsyncGenerator<ProfileRecord> {
  const db = await getDB();
  let cursor = await db
    .transaction('profiles', 'readonly')
    .store.index('byJob')
    .openCursor(IDBKeyRange.only(jobId));
  while (cursor) {
    yield cursor.value;
    cursor = await cursor.continue();
  }
}

/** When export uses only enumeration data (no enrichment), iterate candidates instead. */
export async function* iterateCandidatesAll(
  jobId: string,
): AsyncGenerator<CandidateRecord> {
  const db = await getDB();
  let cursor = await db
    .transaction('candidates', 'readonly')
    .store.index('byJob')
    .openCursor(IDBKeyRange.only(jobId));
  while (cursor) {
    yield cursor.value;
    cursor = await cursor.continue();
  }
}
