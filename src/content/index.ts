import { sendMessage } from '@/lib/messaging';
import { detectProfileUsername } from '@/lib/url';
import type { ExtractedEmail, ExtractionResult } from '@/lib/types';

const ROOT_ID = 'gh-email-hunter-root';
const BUTTON_ID = 'gh-email-hunter-btn';

let currentUsername: string | null = null;

function ensureRoot(username: string): HTMLElement | null {
  // Only inject once per username; if username changed (Turbo nav), recreate.
  const existing = document.getElementById(ROOT_ID);
  if (existing && existing.dataset['username'] === username) return existing;
  if (existing) existing.remove();

  // Anchor: vcard names block in the profile sidebar.
  const anchor =
    document.querySelector('.h-card .vcard-names') ??
    document.querySelector('.h-card .vcard-details') ??
    document.querySelector('.h-card');
  if (!anchor) return null;

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'gh-eh-root';
  root.dataset['username'] = username;
  anchor.insertAdjacentElement('afterend', root);
  return root;
}

function render(root: HTMLElement, username: string): void {
  root.innerHTML = `
    <button id="${BUTTON_ID}" class="gh-eh-btn" type="button">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path fill="currentColor" d="M1.75 2.5h12.5a.25.25 0 0 1 .25.25v.32L8 7.88 1.5 3.07v-.32a.25.25 0 0 1 .25-.25Zm-.25 2.4v8.35c0 .14.11.25.25.25h12.5a.25.25 0 0 0 .25-.25V4.9L8.41 9.39a.75.75 0 0 1-.82 0L1.5 4.9Z"/>
      </svg>
      <span class="gh-eh-btn-label">Find emails</span>
    </button>
    <div class="gh-eh-panel" hidden></div>
  `;
  const btn = root.querySelector<HTMLButtonElement>(`#${BUTTON_ID}`)!;
  const panel = root.querySelector<HTMLElement>('.gh-eh-panel')!;
  btn.addEventListener('click', () => onScanClick(btn, panel, username, false));
}

async function onScanClick(
  btn: HTMLButtonElement,
  panel: HTMLElement,
  username: string,
  force: boolean,
): Promise<void> {
  btn.disabled = true;
  const labelEl = btn.querySelector('.gh-eh-btn-label')!;
  const originalLabel = labelEl.textContent ?? 'Find emails';
  labelEl.textContent = 'Scanning…';
  panel.hidden = false;
  panel.innerHTML = `<div class="gh-eh-status">Querying GitHub…</div>`;

  try {
    const res = await sendMessage({ type: 'EXTRACT', username, level: 'quick', force });
    if (!res.ok) {
      panel.innerHTML = `<div class="gh-eh-error">${escapeHtml(res.error)}</div>`;
      return;
    }
    renderResult(panel, res.data, username);
  } catch (e) {
    panel.innerHTML = `<div class="gh-eh-error">${escapeHtml(String(e))}</div>`;
  } finally {
    btn.disabled = false;
    labelEl.textContent = originalLabel;
  }
}

function renderResult(panel: HTMLElement, result: ExtractionResult, username: string): void {
  const personal = result.emails.filter((e) => e.classification === 'personal');
  const noreply = result.emails.filter((e) => e.classification === 'noreply');
  const meta = `${result.commitsExamined} commits · ${result.reposScanned} repos · ${result.scanLevel}`;
  const ageMin = Math.round((Date.now() - result.scannedAt) / 60000);
  const cacheHint = ageMin > 0 ? ` · cached ${ageMin}m ago` : '';

  panel.innerHTML = `
    <div class="gh-eh-meta">${escapeHtml(meta)}${escapeHtml(cacheHint)}</div>
    ${personal.length === 0
      ? `<div class="gh-eh-empty">No personal email found.${
          noreply.length > 0
            ? ' Only privacy-proxy addresses were exposed.'
            : ' Try a deep scan.'
        }</div>`
      : `<ul class="gh-eh-list">${personal.map(renderEmail).join('')}</ul>`}
    ${noreply.length > 0
      ? `<details class="gh-eh-details">
           <summary>Privacy-proxy addresses (${noreply.length})</summary>
           <ul class="gh-eh-list">${noreply.map(renderEmail).join('')}</ul>
         </details>`
      : ''}
    <div class="gh-eh-actions">
      <button class="gh-eh-link" data-action="deep">Deep scan</button>
      <button class="gh-eh-link" data-action="rescan">Re-scan</button>
      ${result.rateLimit
        ? `<span class="gh-eh-rl">API: ${result.rateLimit.remaining}/${result.rateLimit.limit}</span>`
        : ''}
    </div>
    ${result.warnings.length > 0
      ? `<details class="gh-eh-details">
           <summary>Warnings (${result.warnings.length})</summary>
           <ul>${result.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
         </details>`
      : ''}
  `;

  panel.querySelector<HTMLButtonElement>('[data-action="deep"]')?.addEventListener('click', () =>
    runScan(panel, username, 'deep', true),
  );
  panel.querySelector<HTMLButtonElement>('[data-action="rescan"]')?.addEventListener('click', () =>
    runScan(panel, username, 'quick', true),
  );

  panel.querySelectorAll<HTMLButtonElement>('.gh-eh-copy').forEach((b) => {
    b.addEventListener('click', () => {
      const email = b.dataset['email'];
      if (email) {
        navigator.clipboard.writeText(email).catch(() => {
          /* ignore */
        });
        const original = b.textContent;
        b.textContent = 'Copied';
        setTimeout(() => {
          b.textContent = original;
        }, 1200);
      }
    });
  });
}

async function runScan(
  panel: HTMLElement,
  username: string,
  level: 'quick' | 'deep',
  force: boolean,
): Promise<void> {
  panel.innerHTML = `<div class="gh-eh-status">Scanning${
    level === 'deep' ? ' deeply' : ''
  }…</div>`;
  const res = await sendMessage({ type: 'EXTRACT', username, level, force });
  if (!res.ok) {
    panel.innerHTML = `<div class="gh-eh-error">${escapeHtml(res.error)}</div>`;
    return;
  }
  renderResult(panel, res.data, username);
}

function renderEmail(e: ExtractedEmail): string {
  const sample = e.sources[0];
  const source = sample
    ? `<a class="gh-eh-source" href="${escapeAttr(sample.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sample.repo)}</a>`
    : '';
  return `
    <li class="gh-eh-row">
      <span class="gh-eh-email" title="${escapeAttr(e.email)}">${escapeHtml(e.email)}</span>
      <span class="gh-eh-count">${e.count}×</span>
      <button class="gh-eh-copy" data-email="${escapeAttr(e.email)}" type="button">Copy</button>
      ${source}
    </li>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function tryInject(): void {
  const username = detectProfileUsername(window.location.href);
  if (!username) {
    currentUsername = null;
    document.getElementById(ROOT_ID)?.remove();
    return;
  }
  currentUsername = username;
  const root = ensureRoot(username);
  if (!root) return;
  if (root.childElementCount === 0) render(root, username);
}

// Initial pass + GitHub Turbo SPA navigation handling.
tryInject();
document.addEventListener('turbo:load', tryInject);
document.addEventListener('pjax:end', tryInject);

// Defensive: GitHub sometimes mounts the profile card after Turbo fires.
const observer = new MutationObserver(() => {
  if (currentUsername && !document.getElementById(ROOT_ID)) tryInject();
});
observer.observe(document.body, { childList: true, subtree: true });
