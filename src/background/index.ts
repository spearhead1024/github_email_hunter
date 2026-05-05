import { clearCache, getCached, setCached } from '@/lib/cache';
import { extractEmails } from '@/lib/extractor';
import { getLastRateLimit } from '@/lib/github';
import type { Message } from '@/lib/types';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(() => {
      /* ignore */
    });
  }
});

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      sendResponse({ ok: false, error });
    });
  // Returning true keeps the message channel open for async sendResponse.
  return true;
});

async function handleMessage(message: Message): Promise<unknown> {
  switch (message.type) {
    case 'EXTRACT': {
      if (!message.force) {
        const cached = await getCached(message.username);
        if (cached && cached.scanLevel === message.level) {
          return { ok: true, data: cached };
        }
      }
      try {
        const result = await extractEmails(message.username, message.level);
        await setCached(result);
        return { ok: true, data: result };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    case 'GET_CACHED': {
      const cached = await getCached(message.username);
      return { ok: true, data: cached };
    }
    case 'CLEAR_CACHE': {
      await clearCache();
      return { ok: true };
    }
    case 'GET_RATE_LIMIT': {
      return { ok: true, data: getLastRateLimit() };
    }
  }
}
