import { runEnumeration } from './enumerator';
import { runEnrichment } from './profileEnricher';
import { getTokenPool } from './tokens';
import { getJob, patchJob } from './db';
import type { JobRecord } from './crawlTypes';

const activeJobs = new Map<string, AbortController>();

export function isJobActive(jobId: string): boolean {
  return activeJobs.has(jobId);
}

export async function startJob(jobId: string): Promise<void> {
  if (activeJobs.has(jobId)) return;
  const controller = new AbortController();
  activeJobs.set(jobId, controller);

  try {
    let job = await getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    job = (await patchJob(jobId, { status: 'running' })) ?? job;

    // Phase 1: enumerate
    if (job.phase === 'enumerate' || job.phase === 'enrich') {
      if (job.phase === 'enumerate') {
        await runEnumeration(job, { signal: controller.signal });
        job = (await patchJob(jobId, { phase: 'enrich' })) ?? job;
      }

      // Phase 2: enrich (only if needed)
      const wantEnrich =
        job.fields.includes('emails') || job.fields.includes('last_commit_date');
      if (wantEnrich) {
        const pool = await getTokenPool();
        const concurrency = Math.max(1, pool.ownerCount());
        await runEnrichment(job, { signal: controller.signal, concurrency });
      }
      job = (await patchJob(jobId, { phase: 'done', status: 'completed' })) ?? job;
    } else if (job.phase === 'done') {
      // already complete, nothing to do
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'aborted') {
      await patchJob(jobId, { status: 'paused' });
    } else {
      await patchJob(jobId, { status: 'failed', error: msg });
    }
  } finally {
    activeJobs.delete(jobId);
  }
}

export function pauseJob(jobId: string): void {
  const c = activeJobs.get(jobId);
  if (c) c.abort();
}

export async function cancelJob(jobId: string): Promise<void> {
  const c = activeJobs.get(jobId);
  if (c) c.abort();
  await patchJob(jobId, { status: 'cancelled' });
}

