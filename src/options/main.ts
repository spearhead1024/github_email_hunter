import { getPat, setPat } from '@/lib/storage';
import { sendMessage } from '@/lib/messaging';

const form = document.getElementById('pat-form') as HTMLFormElement;
const input = document.getElementById('pat') as HTMLInputElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;
const clearCacheBtn = document.getElementById('clear-cache') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLSpanElement;

async function init(): Promise<void> {
  const existing = await getPat();
  if (existing) input.placeholder = '••••••••  (saved)';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = input.value.trim();
  if (!value) {
    flash('Enter a token first.', 'err');
    return;
  }
  await setPat(value);
  input.value = '';
  input.placeholder = '••••••••  (saved)';
  flash('Saved.', 'ok');
});

clearBtn.addEventListener('click', async () => {
  await setPat(null);
  input.value = '';
  input.placeholder = 'github_pat_… or ghp_…';
  flash('Token removed.', 'ok');
});

clearCacheBtn.addEventListener('click', async () => {
  await sendMessage({ type: 'CLEAR_CACHE' });
  flash('Cache cleared.', 'ok');
});

function flash(msg: string, kind: 'ok' | 'err'): void {
  status.textContent = msg;
  status.className = `status ${kind}`;
  setTimeout(() => {
    status.textContent = '';
    status.className = 'status';
  }, 2000);
}

init();
