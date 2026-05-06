import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'GitHub Email Hunter',
  version: pkg.version,
  description: pkg.description,
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'GitHub Email Hunter',
  },
  options_page: 'src/options/index.html',
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['https://github.com/*'],
      js: ['src/content/index.ts'],
      css: ['src/content/style.css'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['storage', 'unlimitedStorage', 'offscreen', 'downloads', 'alarms'],
  host_permissions: ['https://api.github.com/*', 'https://github.com/*'],
  // No web_accessible_resources needed: crawl and offscreen are extension-internal
  // pages compiled via rollupOptions.input in vite.config.ts. chrome.offscreen
  // and chrome.tabs.create work with any extension URL without web accessibility.
  web_accessible_resources: [],
});
