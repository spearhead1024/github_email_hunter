import { addToken, listTokens, removeToken } from '@/lib/storage';
import type { TokenMeta } from '@/lib/crawlTypes';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const form = $<HTMLFormElement>('add-form');
const patInput = $<HTMLInputElement>('pat');
const labelInput = $<HTMLInputElement>('label');
const status = $<HTMLSpanElement>('status');
const tokenList = $<HTMLDivElement>('token-list');
const effective = $<HTMLDivElement>('effective');
const clearCacheBtn = $<HTMLButtonElement>('clear-cache');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const secret = patInput.value.trim();
  if (!secret) {
    flash('Enter a token first.', 'err');
    return;
  }
  flash('Verifying…', 'ok');
  try {
    const meta = await verifyToken(secret, labelInput.value.trim());
    await addToken(meta, secret);
    await chrome.runtime.sendMessage({ type: 'TOKENS_CHANGED' }).catch(() => undefined);
    patInput.value = '';
    labelInput.value = '';
    flash(`Added (owner: ${meta.owner}).`, 'ok');
    refresh();
  } catch (err) {
    flash((err as Error).message, 'err');
  }
});

clearCacheBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
  flash('Cache cleared.', 'ok');
});

async function verifyToken(secret: string, labelOverride: string): Promise<TokenMeta> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${secret}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`Token rejected: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { login: string };
  const scopesHeader = res.headers.get('x-oauth-scopes') ?? '';
  const scopes = scopesHeader
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    id: crypto.randomUUID(),
    label: labelOverride || `${body.login}${scopes.length ? ` (${scopes.join(',')})` : ''}`,
    owner: body.login,
    scopes,
    addedAt: Date.now(),
    lastVerifiedAt: Date.now(),
  };
}

async function refresh(): Promise<void> {
  const tokens = await listTokens();
  if (tokens.length === 0) {
    tokenList.innerHTML = `<p class="status">No tokens yet.</p>`;
    effective.innerHTML = '';
    return;
  }

  const ownerCounts = new Map<string, number>();
  for (const t of tokens) ownerCounts.set(t.owner, (ownerCounts.get(t.owner) ?? 0) + 1);

  tokenList.innerHTML = tokens
    .map((t) => {
      const shared = (ownerCounts.get(t.owner) ?? 0) > 1;
      return `
        <div class="token ${shared ? 'shared' : ''}" data-id="${escapeAttr(t.id)}">
          <div class="info">
            <div class="label">
              ${escapeHtml(t.label)}
              ${shared ? `<span class="badge">shared bucket</span>` : ''}
            </div>
            <div class="meta">
              owner: ${escapeHtml(t.owner)}
              ${t.scopes.length > 0 ? ` · scopes: ${escapeHtml(t.scopes.join(','))}` : ''}
            </div>
          </div>
          <button class="danger" data-action="remove">Remove</button>
        </div>
      `;
    })
    .join('');

  tokenList.querySelectorAll<HTMLButtonElement>('button[data-action="remove"]').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.closest('.token')!.getAttribute('data-id')!;
      await removeToken(id);
      await chrome.runtime.sendMessage({ type: 'TOKENS_CHANGED' }).catch(() => undefined);
      refresh();
    });
  });

  const ownerCount = ownerCounts.size;
  effective.innerHTML = `
    Effective parallelism: <strong>${ownerCount} bucket${ownerCount === 1 ? '' : 's'}</strong>
    (${tokens.length} token${tokens.length === 1 ? '' : 's'},
    ${ownerCount} distinct account${ownerCount === 1 ? '' : 's'})
    ${tokens.length > ownerCount
      ? `<div class="status err" style="margin-top:6px">Multiple tokens from the same account share quota — no extra throughput.</div>`
      : ''}
  `;
}

function flash(msg: string, kind: 'ok' | 'err'): void {
  status.textContent = msg;
  status.className = `status ${kind}`;
  if (kind === 'ok' && msg !== 'Verifying…') {
    setTimeout(() => {
      status.textContent = '';
      status.className = 'status';
    }, 3000);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
function escapeAttr(s: string): string { return escapeHtml(s); }

refresh();
