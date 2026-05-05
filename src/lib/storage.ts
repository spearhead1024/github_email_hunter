const PAT_KEY = 'github_pat';

export async function getPat(): Promise<string | null> {
  const result = await chrome.storage.local.get(PAT_KEY);
  const pat = result[PAT_KEY];
  return typeof pat === 'string' && pat.length > 0 ? pat : null;
}

export async function setPat(pat: string | null): Promise<void> {
  if (pat === null || pat === '') {
    await chrome.storage.local.remove(PAT_KEY);
  } else {
    await chrome.storage.local.set({ [PAT_KEY]: pat });
  }
}
