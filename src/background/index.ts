import { clearCache, getCached, setCached } from '@/lib/cache';
import { extractEmails } from '@/lib/extractor';
import { getLastRateLimit } from '@/lib/github';
import { putJob, listJobs, getJob, deleteJob } from '@/lib/db';
import { buildCsv, blobToDataUrl, csvFilename } from '@/lib/exporter';
import { listTokensWithSecrets } from '@/lib/storage';
import type { JobRecord } from '@/lib/crawlTypes';
import type { Message } from '@/lib/types';

const OFFSCREEN_URL = 'src/offscreen/index.html';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(() => {
      /* ignore */
    });
  }
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  // Don't intercept messages targeted at the offscreen doc.
  if ((message as { target?: string }).target === 'offscreen') return;

  const m = message as Message | { type: string; [k: string]: unknown };
  handleMessage(m)
    .then(sendResponse)
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      sendResponse({ ok: false, error });
    });
  return true;
});

async function handleMessage(message: { type: string; [k: string]: unknown }): Promise<unknown> {
  switch (message.type) {
    // ---- Single-profile lookup (existing) ----
    case 'EXTRACT': {
      const m = message as Extract<Message, { type: 'EXTRACT' }>;
      if (!m.force) {
        const cached = await getCached(m.username);
        if (cached && cached.scanLevel === m.level) {
          return { ok: true, data: cached };
        }
      }
      try {
        const result = await extractEmails(m.username, m.level);
        await setCached(result);
        return { ok: true, data: result };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    case 'GET_CACHED': {
      const m = message as Extract<Message, { type: 'GET_CACHED' }>;
      return { ok: true, data: await getCached(m.username) };
    }
    case 'CLEAR_CACHE':
      await clearCache();
      return { ok: true };
    case 'GET_RATE_LIMIT':
      return { ok: true, data: getLastRateLimit() };

    // ---- Crawl messages ----
    case 'CRAWL_START': {
      const job = (message as unknown as { job: JobRecord }).job;
      await putJob(job);
      await ensureOffscreen();
      const tokens = await listTokensWithSecrets();
      await sendToOffscreen({ target: 'offscreen', cmd: 'START', jobId: job.id, tokens });
      return { ok: true, data: { jobId: job.id } };
    }
    case 'CRAWL_PAUSE': {
      const id = String(message['jobId']);
      await sendToOffscreen({ target: 'offscreen', cmd: 'PAUSE', jobId: id });
      return { ok: true };
    }
    case 'CRAWL_RESUME': {
      const id = String(message['jobId']);
      await ensureOffscreen();
      const tokens = await listTokensWithSecrets();
      await sendToOffscreen({ target: 'offscreen', cmd: 'RESUME', jobId: id, tokens });
      return { ok: true };
    }
    case 'CRAWL_CANCEL': {
      const id = String(message['jobId']);
      await sendToOffscreen({ target: 'offscreen', cmd: 'CANCEL', jobId: id });
      return { ok: true };
    }
    case 'CRAWL_EXPORT': {
      // Export runs entirely in the SW: chrome.downloads is unavailable in the
      // offscreen document context.
      const id = String(message['jobId']);
      const job = await getJob(id);
      if (!job) return { ok: false, error: 'Job not found' };
      const blob = await buildCsv(job);
      const url = await blobToDataUrl(blob);
      const filename = csvFilename(job);
      await chrome.downloads.download({ url, filename, saveAs: true });
      return { ok: true, data: { filename, bytes: blob.size } };
    }
    case 'CRAWL_GET_STATE': {
      const id = String(message['jobId']);
      const job = await getJob(id);
      return { ok: true, data: { job: job ?? null } };
    }
    case 'CRAWL_LIST': {
      return { ok: true, data: await listJobs() };
    }
    case 'CRAWL_DELETE': {
      const id = String(message['jobId']);
      await deleteJob(id);
      return { ok: true };
    }
    case 'TOKENS_CHANGED': {
      await ensureOffscreen();
      const tokens = await listTokensWithSecrets();
      await sendToOffscreen({ target: 'offscreen', cmd: 'TOKENS_CHANGED', tokens });
      return { ok: true };
    }
    case 'CRAWL_TOKEN_SNAPSHOT': {
      const has = await chrome.offscreen.hasDocument().catch(() => false);
      if (!has) return { ok: true, data: { tokenCount: 0, ownerCount: 0, buckets: [] } };
      const result = await sendToOffscreen({ target: 'offscreen', cmd: 'TOKEN_SNAPSHOT' });
      return result;
    }
    case 'PING':
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}

async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument().catch(() => false);
  if (has) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS' as chrome.offscreen.Reason],
    justification: 'Run long crawl jobs that exceed the service worker idle timeout.',
  });
}

// The offscreen document is created asynchronously. Its onMessage listener is
// registered only after the page's JS module finishes loading, which can take
// 200-800ms. Sending a message immediately after createDocument fails with
// "Receiving end does not exist". We retry with backoff until the listener is up.
async function sendToOffscreen(msg: object): Promise<unknown> {
  const send = () => chrome.runtime.sendMessage(msg);
  const isNotReady = (e: unknown) => {
    const t = (e as Error).message ?? '';
    return t.includes('Receiving end does not exist') || t.includes('Could not establish connection');
  };
  const delays = [0, 150, 350, 700, 1200];
  let lastErr: unknown;
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      return await send();
    } catch (e) {
      if (!isNotReady(e)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}
