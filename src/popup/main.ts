import { listCached, clearCache } from '@/lib/cache';
import { sendMessage } from '@/lib/messaging';
import { parseGitHubProfile } from '@/lib/url';
import type { ExtractedEmail, ExtractionResult } from '@/lib/types';

const form = document.getElementById('form') as HTMLFormElement;
const input = document.getElementById('input') as HTMLInputElement;
const submit = document.getElementById('submit') as HTMLButtonElement;
const result = document.getElementById('result') as HTMLElement;
const historyList = document.getElementById('history-list') as HTMLUListElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;
const optionsLink = document.getElementById('open-options') as HTMLAnchorElement;
const crawlLink = document.getElementById('open-crawl') as HTMLAnchorElement;

optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

crawlLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('src/crawl/index.html') });
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = parseGitHubProfile(input.value);
  if (!username) {
    showError('Enter a valid GitHub profile URL or username.');
    return;
  }
  scan(username, 'quick', false);
});

clearBtn.addEventListener('click', async () => {
  await clearCache();
  refreshHistory();
  result.innerHTML = '';
});

async function scan(username: string, level: 'quick' | 'deep', force: boolean): Promise<void> {
  submit.disabled = true;
  submit.textContent = 'Scanning…';
  result.innerHTML = `<div class="meta">Scanning ${escapeHtml(username)}…</div>`;
  try {
    const res = await sendMessage({ type: 'EXTRACT', username, level, force });
    if (!res.ok) {
      showError(res.error);
      return;
    }
    renderResult(res.data);
    refreshHistory();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  } finally {
    submit.disabled = false;
    submit.textContent = 'Find';
  }
}

function showError(msg: string): void {
  result.innerHTML = `<div class="err">${escapeHtml(msg)}</div>`;
}

function renderResult(data: ExtractionResult): void {
  const personal = data.emails.filter((e) => e.classification === 'personal');
  const noreply = data.emails.filter((e) => e.classification === 'noreply');

  const meta = `${data.username} · ${data.commitsExamined} commits · ${data.reposScanned} repos · ${data.scanLevel}`;
  result.innerHTML = `
    <div class="meta">${escapeHtml(meta)}</div>
    ${personal.length === 0
      ? `<div class="empty">No personal email found${
          noreply.length > 0 ? ' — only privacy-proxy addresses' : ''
        }.</div>`
      : `<ul>${personal.map(renderRow).join('')}</ul>`}
    ${noreply.length > 0
      ? `<details>
           <summary>Privacy-proxy (${noreply.length})</summary>
           <ul>${noreply.map(renderRow).join('')}</ul>
         </details>`
      : ''}
    <div class="actions">
      <button class="link" data-action="deep">Deep scan</button>
      <button class="link" data-action="rescan">Re-scan</button>
      ${data.rateLimit
        ? `<span class="rl">API: ${data.rateLimit.remaining}/${data.rateLimit.limit}</span>`
        : ''}
    </div>
    ${data.warnings.length > 0
      ? `<details>
           <summary>Warnings (${data.warnings.length})</summary>
           <ul>${data.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
         </details>`
      : ''}
  `;
  result.querySelector<HTMLButtonElement>('[data-action="deep"]')?.addEventListener('click', () =>
    scan(data.username, 'deep', true),
  );
  result
    .querySelector<HTMLButtonElement>('[data-action="rescan"]')
    ?.addEventListener('click', () => scan(data.username, 'quick', true));
  result.querySelectorAll<HTMLButtonElement>('.copy').forEach((b) => {
    b.addEventListener('click', () => {
      const email = b.dataset['email'];
      if (!email) return;
      navigator.clipboard.writeText(email).catch(() => undefined);
      const original = b.textContent;
      b.textContent = 'Copied';
      setTimeout(() => {
        b.textContent = original;
      }, 1200);
    });
  });
}

function renderRow(e: ExtractedEmail): string {
  return `
    <li>
      <span class="email" title="${escapeAttr(e.email)}">${escapeHtml(e.email)}</span>
      <span class="count">${e.count}×</span>
      <button class="copy" data-email="${escapeAttr(e.email)}" type="button">Copy</button>
    </li>
  `;
}

async function refreshHistory(): Promise<void> {
  const entries = await listCached();
  if (entries.length === 0) {
    historyList.innerHTML = '';
    return;
  }
  historyList.innerHTML = entries
    .slice(0, 8)
    .map((e) => {
      const ago = formatAgo(Date.now() - e.scannedAt);
      const top =
        e.emails.find((x) => x.classification === 'personal')?.email ?? '(no personal email)';
      return `
        <li data-username="${escapeAttr(e.username)}">
          <span>${escapeHtml(e.username)} · <span class="email">${escapeHtml(top)}</span></span>
          <span class="ago">${escapeHtml(ago)}</span>
        </li>
      `;
    })
    .join('');
  historyList.querySelectorAll<HTMLLIElement>('li').forEach((li) => {
    li.addEventListener('click', () => {
      const u = li.dataset['username'];
      if (!u) return;
      input.value = u;
      scan(u, 'quick', false);
    });
  });
}

function formatAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// Bootstrap
refreshHistory();
chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
  const tab = tabs[0];
  if (!tab?.url) return;
  const username = parseGitHubProfile(tab.url);
  if (username) input.value = username;
});
