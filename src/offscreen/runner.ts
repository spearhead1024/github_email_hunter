import { cancelJob, isJobActive, pauseJob, startJob } from '@/lib/jobRunner';
import { getTokenPool, setTokenPoolFromList } from '@/lib/tokens';
import type { TokenWithSecret } from '@/lib/storage';

interface InboundMessage {
  target?: 'offscreen';
  cmd: 'START' | 'PAUSE' | 'RESUME' | 'CANCEL' | 'TOKENS_CHANGED' | 'PING' | 'TOKEN_SNAPSHOT';
  jobId?: string;
  tokens?: TokenWithSecret[];
}

chrome.runtime.onMessage.addListener((msg: InboundMessage, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  handle(msg)
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((e: unknown) =>
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
  return true; // keep channel open for async sendResponse
});

async function handle(msg: InboundMessage): Promise<unknown> {
  switch (msg.cmd) {
    case 'START':
    case 'RESUME':
      if (!msg.jobId) throw new Error('jobId required');
      // Tokens are passed from the background (chrome.storage unavailable here).
      if (msg.tokens) setTokenPoolFromList(msg.tokens);
      // Fire-and-forget: long running. Don't await — let SW move on.
      startJob(msg.jobId).catch((e) => console.error('[offscreen] job error', e));
      return { running: true };
    case 'PAUSE':
      if (!msg.jobId) throw new Error('jobId required');
      pauseJob(msg.jobId);
      return { paused: true };
    case 'CANCEL':
      if (!msg.jobId) throw new Error('jobId required');
      await cancelJob(msg.jobId);
      return { cancelled: true };
    case 'TOKENS_CHANGED':
      if (msg.tokens) setTokenPoolFromList(msg.tokens);
      return { reloaded: true };
    case 'TOKEN_SNAPSHOT':
      return (await getTokenPool()).snapshot();
    case 'PING':
      return { pong: true, active: msg.jobId ? isJobActive(msg.jobId) : null };
  }
}
