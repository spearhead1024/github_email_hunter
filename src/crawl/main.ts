import './style.css';
import type { Field, JobRecord } from '@/lib/crawlTypes';
import { parseSearchInput } from '@/lib/searchQuery';

// ── DOM refs ─────────────────────────────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const viewSetup    = $('view-setup');
const viewRunning  = $('view-running');
const form         = $<HTMLFormElement>('form');
const searchUrlEl  = $<HTMLInputElement>('search-url');
const limitNumEl   = $<HTMLInputElement>('limit-number');
const fallbackEl   = $<HTMLInputElement>('fallback');
const startBtn     = $<HTMLButtonElement>('start-btn');
const formError    = $('form-error');
const costEst      = $('cost-est');

const jobStatusPill   = $('job-status-pill');
const jobTitle        = $('job-title');
const jobTime         = $('job-time');
const progressEnum    = $('progress-enum');
const progressEnrich  = $('progress-enrich');
const enumStats       = $('enum-stats');
const enumBar         = $('enum-bar');
const enrichStats     = $('enrich-stats');
const enrichBar       = $('enrich-bar');
const jobErrorEl      = $('job-error');
const pauseBtn        = $<HTMLButtonElement>('pause-btn');
const resumeBtn       = $<HTMLButtonElement>('resume-btn');
const cancelBtn       = $<HTMLButtonElement>('cancel-btn');
const newJobBtn       = $<HTMLButtonElement>('new-job-btn');
const exportBtn       = $<HTMLButtonElement>('export-btn');

const tokensMeta  = $('tokens-meta');
const tokensBody  = $('tokens-body');
const jobsBadge   = $('jobs-badge');
const jobsList    = $('jobs-list');

// ── App state ────────────────────────────────────────────────────
let activeJobId: string | null = null;
let jobTimer: ReturnType<typeof setInterval> | null = null;
let tokenTimer: ReturnType<typeof setInterval> | null = null;

// ── Options link ─────────────────────────────────────────────────
$<HTMLAnchorElement>('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ── Cost estimate ─────────────────────────────────────────────────
function getCheckedFields(): Field[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[name="field"]:checked')]
    .map((el) => el.value as Field);
}

function getLimitMode(): 'number' | 'all' {
  return (
    (document.querySelector<HTMLInputElement>('input[name="limit-mode"]:checked')?.value ?? 'number') as 'number' | 'all'
  );
}

function getLimit(): number {
  if (getLimitMode() === 'all') return 0;
  const n = parseInt(limitNumEl.value || '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

function updateCostEst(): void {
  const fields = getCheckedFields();
  const limit  = getLimit();
  const wantEnrich = fields.includes('emails') || fields.includes('last_commit_date');
  const N = limit > 0 ? limit : 50_000;

  const graphql = Math.ceil(N / 100);
  const core    = wantEnrich ? N : 0;
  const search  = wantEnrich && fallbackEl.checked ? Math.round(N * 0.2) : 0;

  const parts: string[] = [`GraphQL ~${fmt(graphql)} pts`];
  if (core)   parts.push(`Core REST ~${fmt(core)} calls`);
  if (search) parts.push(`Search ~${fmt(search)} calls (fallback)`);

  costEst.textContent = `Estimated: ${parts.join(' · ')} for ~${fmt(N)} users`;
}

document
  .querySelectorAll('input[name="field"], input[name="limit-mode"], #limit-number, #fallback')
  .forEach((el) => el.addEventListener('input', updateCostEst));
updateCostEst();

// ── Limit input visibility ────────────────────────────────────────
document.querySelectorAll<HTMLInputElement>('input[name="limit-mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    limitNumEl.disabled = getLimitMode() === 'all';
  });
});

// ── View switching ────────────────────────────────────────────────
function showSetup(): void {
  viewSetup.hidden   = false;
  viewRunning.hidden = true;
  stopJobPoll();
}

function showRunning(jobId: string): void {
  activeJobId        = jobId;
  viewSetup.hidden   = true;
  viewRunning.hidden = false;
  startJobPoll();
}

// ── Disconnect banner ─────────────────────────────────────────────
let disconnectBannerShown = false;

function showDisconnectBanner(): void {
  if (disconnectBannerShown) return;
  disconnectBannerShown = true;
  const banner = document.createElement('div');
  banner.id = 'disconnect-banner';
  banner.innerHTML =
    '⚠ Extension reloaded — <strong>close and reopen this tab</strong> to reconnect.' +
    ' <button id="banner-close">✕</button>';
  document.body.prepend(banner);
  document.getElementById('banner-close')!.addEventListener('click', () => {
    banner.remove();
    disconnectBannerShown = false;
  });
}

// ── Messaging helper ─────────────────────────────────────────────
// MV3 service workers terminate after ~30s of inactivity. sendMessage can fail
// while Chrome wakes the SW back up. We retry with increasing delays totalling
// ~2.5s. If all retries fail we check whether the extension context is still
// valid. If not (tab survived an extension reload) we show a persistent banner;
// otherwise it's a genuine SW failure and we surface the error normally.
function isConnectionError(e: unknown): boolean {
  const t = (e as Error).message ?? '';
  return (
    t.includes('Receiving end does not exist') ||
    t.includes('Could not establish connection') ||
    t.includes('Extension context invalidated')
  );
}

async function sendMsg(message: object): Promise<unknown> {
  // Delays: immediate, 300ms, 700ms, 1500ms — total ~2.5s worst-case
  const delays = [0, 300, 700, 1500];
  let lastErr: unknown;
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      if (!isConnectionError(e)) throw e;
      lastErr = e;
    }
  }
  // All retries exhausted — distinguish invalidated context from SW failure
  let contextAlive = true;
  try { void chrome.runtime.id; } catch { contextAlive = false; }
  if (!contextAlive) {
    showDisconnectBanner();
    throw new Error('Extension reloaded. Close and reopen this tab to reconnect.');
  }
  throw new Error(`Could not reach extension background. ${(lastErr as Error).message ?? ''}`);
}

// ── Form submit ───────────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearFormError();

  const parsed = parseSearchInput(searchUrlEl.value.trim());
  if (!parsed) {
    showFormError('Enter a valid GitHub search URL or query (e.g. location:Poland).');
    return;
  }

  const fields = getCheckedFields();
  if (fields.length === 0) {
    showFormError('Select at least one output field.');
    return;
  }

  const job: JobRecord = {
    id: crypto.randomUUID(),
    query: parsed.query,
    rawSearchUrl: parsed.rawUrl,
    limit: getLimit(),
    fields,
    fallbackSearchCommits: fallbackEl.checked,
    status: 'running',
    phase: 'enumerate',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    counts: { estimatedTotal: 0, discovered: 0, enriched: 0, failed: 0 },
  };

  startBtn.disabled = true;
  startBtn.textContent = 'Starting…';
  try {
    const res = await sendMsg({ type: 'CRAWL_START', job }) as { ok: boolean; error?: string };
    if (!res?.ok) throw new Error(res?.error ?? 'Failed to start crawl');
    showRunning(job.id);
    renderJob(job);
    void refreshJobsList();
  } catch (err) {
    showFormError((err as Error).message);
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = 'Start Crawl';
  }
});

function showFormError(msg: string): void {
  formError.textContent = msg;
  formError.hidden = false;
}

function clearFormError(): void {
  formError.hidden = true;
  formError.textContent = '';
}

// ── Control buttons ───────────────────────────────────────────────
pauseBtn.addEventListener('click', async () => {
  if (!activeJobId) return;
  pauseBtn.disabled = true;
  await sendMsg({ type: 'CRAWL_PAUSE', jobId: activeJobId }).catch(() => null);
  pauseBtn.disabled = false;
});

resumeBtn.addEventListener('click', async () => {
  if (!activeJobId) return;
  resumeBtn.disabled = true;
  await sendMsg({ type: 'CRAWL_RESUME', jobId: activeJobId }).catch(() => null);
  resumeBtn.disabled = false;
});

cancelBtn.addEventListener('click', async () => {
  if (!activeJobId) return;
  if (!confirm('Cancel this crawl? Already-collected data can still be exported.')) return;
  cancelBtn.disabled = true;
  await sendMsg({ type: 'CRAWL_CANCEL', jobId: activeJobId }).catch(() => null);
  cancelBtn.disabled = false;
});

exportBtn.addEventListener('click', () => {
  if (activeJobId) void doExport(activeJobId, exportBtn);
});

newJobBtn.addEventListener('click', () => {
  showSetup();
  void refreshJobsList();
});

async function doExport(jobId: string, btn?: HTMLButtonElement): Promise<void> {
  if (btn) btn.disabled = true;
  try {
    const res = await sendMsg({ type: 'CRAWL_EXPORT', jobId }) as { ok: boolean; error?: string };
    if (res?.ok === false) throw new Error(res.error ?? 'Export failed');
  } catch (err) {
    alert((err as Error).message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Job polling ───────────────────────────────────────────────────
function startJobPoll(): void {
  stopJobPoll();
  void refreshJob();
  jobTimer = setInterval(() => void refreshJob(), 1000);
}

function stopJobPoll(): void {
  if (jobTimer !== null) { clearInterval(jobTimer); jobTimer = null; }
}

async function refreshJob(): Promise<void> {
  if (!activeJobId) return;
  const res = await sendMsg({ type: 'CRAWL_GET_STATE', jobId: activeJobId }).catch(() => null);
  if (!res || !(res as { ok: boolean }).ok) return;
  renderJob((res as { data: { job: JobRecord } }).data.job);
}

function renderJob(job: JobRecord): void {
  const { counts, phase, status, query, limit, fields, updatedAt } = job;
  void phase; // used for display via status only

  // Status pill
  jobStatusPill.textContent = status.toUpperCase();
  jobStatusPill.className   = `status-pill status-${status}`;

  // Title & time
  const limitLabel = limit > 0 ? ` · limit ${fmt(limit)}` : ' · all users';
  jobTitle.textContent = truncate(query, 60) + limitLabel;
  jobTime.textContent  = formatAgo(Date.now() - updatedAt) + ' ago';

  // Enumeration progress
  const total = counts.estimatedTotal > 0
    ? counts.estimatedTotal
    : limit > 0 ? limit : Math.max(counts.discovered, 1);
  setBar(enumBar, counts.discovered, total);
  enumStats.textContent = `${fmt(counts.discovered)} / ${fmt(total)}`;

  // Enrichment progress
  const wantEnrich = fields.includes('emails') || fields.includes('last_commit_date');
  progressEnrich.hidden = !wantEnrich;
  if (wantEnrich) {
    const enrichTotal = Math.max(counts.discovered, 1);
    const enrichDone  = counts.enriched + counts.failed;
    setBar(enrichBar, enrichDone, enrichTotal);
    enrichStats.textContent = `${fmt(counts.enriched)} enriched · ${fmt(counts.failed)} failed`;
  }

  // Error
  if (job.error) {
    jobErrorEl.textContent = job.error;
    jobErrorEl.hidden = false;
  } else {
    jobErrorEl.hidden = true;
  }

  // Control buttons
  const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  pauseBtn.hidden   = status !== 'running';
  resumeBtn.hidden  = status !== 'paused';
  cancelBtn.hidden  = isTerminal;
  newJobBtn.hidden  = !isTerminal;
  exportBtn.disabled = counts.discovered === 0;

  // Stop polling when job is done
  if (isTerminal) {
    stopJobPoll();
    void refreshJobsList();
  }
}

function setBar(bar: HTMLElement, n: number, d: number): void {
  const pct = d > 0 ? Math.min(100, (n / d) * 100) : 0;
  bar.style.width = `${pct}%`;
}

// ── Token snapshot ────────────────────────────────────────────────
interface BucketEntry {
  key: string;
  remaining: number;
  limit: number;
  reset: number;
  cooldownUntil: number;
}

interface TokenSnap {
  tokenCount: number;
  ownerCount: number;
  buckets: BucketEntry[];
}

async function refreshTokens(): Promise<void> {
  const res = await sendMsg({ type: 'CRAWL_TOKEN_SNAPSHOT' }).catch(() => null);
  if (!res || !(res as { ok: boolean }).ok) return;
  renderTokens((res as { data: TokenSnap }).data);
}

function renderTokens(snap: TokenSnap): void {
  const now = Date.now();

  if (!snap || snap.buckets.length === 0) {
    tokensBody.innerHTML = '<p class="muted">No token activity yet.</p>';
    tokensMeta.textContent = '';
    return;
  }

  tokensMeta.textContent =
    `${snap.tokenCount} token${snap.tokenCount !== 1 ? 's' : ''} · ${snap.ownerCount} owner${snap.ownerCount !== 1 ? 's' : ''}`;

  const rows = snap.buckets
    .filter((b) => Number.isFinite(b.remaining) || b.cooldownUntil > now)
    .sort((a, b) => a.key.localeCompare(b.key));

  if (rows.length === 0) {
    tokensBody.innerHTML = '<p class="muted">No API calls made yet.</p>';
    return;
  }

  tokensBody.innerHTML = `
    <table class="token-table">
      <thead>
        <tr>
          <th>Owner</th>
          <th>Bucket</th>
          <th>Remaining / Limit</th>
          <th>Used</th>
          <th>Resets</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map((b) => {
            const [owner, bucket] = b.key.split(':') as [string, string];
            const isInf = !Number.isFinite(b.remaining);
            const rem   = isInf ? '—' : fmt(b.remaining);
            const lim   = isInf ? '—' : fmt(b.limit);
            const usedPct =
              !isInf && b.limit > 0
                ? Math.round(((b.limit - b.remaining) / b.limit) * 100)
                : 0;
            const inCooldown = b.cooldownUntil > now;
            const resetText  = inCooldown
              ? `⏳ ${formatMs(b.cooldownUntil - now)}`
              : b.reset > now
                ? `in ${formatMs(b.reset - now)}`
                : '—';

            return `<tr${inCooldown ? ' class="row-cooldown"' : ''}>
              <td class="mono">${escapeHtml(owner)}</td>
              <td><span class="bucket-badge bucket-${escapeHtml(bucket)}">${escapeHtml(bucket)}</span></td>
              <td>
                <div class="usage-cell">
                  <div class="usage-track"><div class="usage-fill" style="width:${usedPct}%"></div></div>
                  <span class="usage-text">${rem} / ${lim}</span>
                </div>
              </td>
              <td class="usage-pct">${isInf ? '' : `${usedPct}%`}</td>
              <td class="reset-text">${resetText}</td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table>
  `;
}

// ── Jobs list ─────────────────────────────────────────────────────
async function refreshJobsList(): Promise<void> {
  const res = await sendMsg({ type: 'CRAWL_LIST' }).catch(() => null);
  if (!res || !(res as { ok: boolean }).ok) return;
  const jobs: JobRecord[] = (res as { data: JobRecord[] }).data;

  if (jobs.length > 0) {
    jobsBadge.textContent = String(jobs.length);
    jobsBadge.hidden = false;
  } else {
    jobsBadge.hidden = true;
  }

  if (jobs.length === 0) {
    jobsList.innerHTML = '<p class="muted">No jobs yet.</p>';
    return;
  }

  jobsList.innerHTML = `
    <table class="jobs-table">
      <thead>
        <tr>
          <th>Query</th>
          <th>Status</th>
          <th style="text-align:right">Found</th>
          <th style="text-align:right">Enriched</th>
          <th>Updated</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${jobs
          .map(
            (j) => `
          <tr data-id="${escapeAttr(j.id)}">
            <td class="query-cell" title="${escapeAttr(j.query)}">${escapeHtml(truncate(j.query, 40))}</td>
            <td><span class="status-pill status-${j.status}">${j.status}</span></td>
            <td class="num-cell">${fmt(j.counts.discovered)}</td>
            <td class="num-cell">${fmt(j.counts.enriched)}</td>
            <td class="ago-cell">${formatAgo(Date.now() - j.updatedAt)}</td>
            <td class="actions-cell">
              ${j.status === 'running' || j.status === 'paused'
                ? `<button class="btn btn-xs" data-action="open">Open</button>`
                : ''}
              <button class="btn btn-xs" data-action="export"${j.counts.discovered === 0 ? ' disabled' : ''}>Export</button>
              <button class="btn-danger-xs" data-action="delete">Del</button>
            </td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>
  `;

  jobsList.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest<HTMLTableRowElement>('tr')!;
      const id = tr.dataset['id']!;
      const action = btn.dataset['action'];

      if (action === 'open') {
        showRunning(id);
        void refreshJob();
      } else if (action === 'export') {
        await doExport(id);
      } else if (action === 'delete') {
        if (!confirm('Delete this job and all its collected data?')) return;
        await sendMsg({ type: 'CRAWL_DELETE', jobId: id }).catch(() => null);
        if (activeJobId === id) showSetup();
        void refreshJobsList();
      }
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────
function fmt(n: number): string { return n.toLocaleString(); }

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function formatAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function escapeAttr(s: string): string { return escapeHtml(s); }

// ── Bootstrap ─────────────────────────────────────────────────────

// Pre-warm the SW connection on load and on focus so the first real call lands
// on an already-running worker instead of racing against wakeup.
function pingBackground(): void {
  sendMsg({ type: 'PING' }).catch(() => undefined);
}
pingBackground();
window.addEventListener('focus', pingBackground);

// Always poll tokens (every 4s) — returns empty if no offscreen doc
tokenTimer = setInterval(() => void refreshTokens(), 4000);
void refreshTokens();

// Jobs list polling
void refreshJobsList();
setInterval(() => void refreshJobsList(), 10_000);

// Auto-restore: if a job is already running/paused when the tab opens, show it
sendMsg({ type: 'CRAWL_LIST' })
  .then((res) => {
    const r = res as { ok: boolean; data: JobRecord[] };
    if (!r?.ok) return;
    const active = r.data.find((j) => j.status === 'running' || j.status === 'paused');
    if (active) {
      showRunning(active.id);
      renderJob(active);
    }
  })
  .catch(() => undefined);
