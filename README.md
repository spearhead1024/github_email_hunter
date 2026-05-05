# GitHub Email Hunter

A Chrome extension that extracts personal email addresses from a GitHub profile by reading the public commit metadata that GitHub already exposes.

> **Why does this work?** Every git commit carries `author.name` and `author.email`. GitHub mirrors that data in its API and `.patch` endpoints for every public repository. This extension just queries it and aggregates.

## Features

- **Profile-page button** — on any `https://github.com/{user}` page, a "Find emails" button is injected into the profile sidebar.
- **Manual lookup popup** — paste a profile URL or username; auto-fills from the active tab.
- **Two-stage scan** — quick scan uses the public events feed (1 API call, ~90 days). Deep scan iterates the user's owned repos.
- **Smart filtering** — separates personal emails from `users.noreply.github.com` privacy proxies and bot addresses, ranks by commit frequency.
- **Source provenance** — every email is linked to a sample commit so you can verify it.
- **Local cache** — 24h TTL, scoped to your browser only.
- **Optional Personal Access Token** — raises rate limit from 60/hour to 5,000/hour. No scopes required. Stored locally.

## Build

```bash
npm install
npm run build      # produces dist/
npm run dev        # vite dev server with HMR
npm test           # vitest unit tests
```

## Install (unpacked, for development)

1. `npm run build`
2. Open `chrome://extensions`
3. Toggle **Developer mode** on
4. Click **Load unpacked** → select the `dist/` folder

## Architecture

```
src/
├── background/index.ts     MV3 service worker — message router, runs all GitHub calls
├── content/                Injects "Find emails" button on github.com/{user}
├── popup/                  Toolbar popup — manual lookup + history
├── options/                PAT setup + cache management
└── lib/
    ├── github.ts           API wrapper (auth, rate-limit awareness, error classes)
    ├── extractor.ts        Strategy 1 (events) → Strategy 2 (repo commits)
    ├── filter.ts           Email classification + frequency ranking
    ├── cache.ts            chrome.storage.local with 24h TTL, max 50 entries
    ├── url.ts              GitHub URL/username parsing
    ├── messaging.ts        Typed sendMessage wrapper
    └── types.ts            Shared types
```

All `fetch` calls happen in the service worker. Content scripts and popup talk to it via `chrome.runtime.sendMessage`. This keeps host permissions tight and avoids CORS edge cases.

## Permissions

| Permission | Purpose |
|---|---|
| `storage` | Cache results + store optional PAT locally |
| `host_permissions: api.github.com` | API calls |
| `host_permissions: github.com` | Content script injection on profile pages |

No `tabs`, no `<all_urls>`, no remote code, no analytics.

## Privacy & responsible use

Commit emails are **already public** — anyone can run `git log` on a cloned public repo and see the same data. This extension just makes that lookup faster. Even so:

- Do not bulk-scrape. There is no CSV export and no list mode by design.
- Do not spam scanned addresses. Cold-emailing maintainers via a commit address is widely considered hostile.
- If a user has set up GitHub's privacy proxy (`*@users.noreply.github.com`), respect it — they have explicitly opted out of exposing their real address.

To hide your own email, enable **"Keep my email addresses private"** in [GitHub email settings](https://github.com/settings/emails) and set `git config user.email` to the proxy address GitHub provides.

## Roadmap

- [ ] Pagination for deep scan (multiple commit pages per repo)
- [ ] Public event source attribution (currently scoped to PushEvent)
- [ ] Co-author trailer parsing (`Co-authored-by:` in commit messages)
- [ ] Firefox MV3 manifest variant
- [ ] Custom icon set

## License

MIT
