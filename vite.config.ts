import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    rollupOptions: {
      // crxjs only auto-processes popup/options_page as HTML entry points.
      // web_accessible_resources HTML is copied raw without compiling TS/CSS.
      // Listing both crawl and offscreen here forces Vite to compile them and
      // rewrite asset links. Neither should appear in web_accessible_resources.
      input: {
        crawl: fileURLToPath(new URL('src/crawl/index.html', import.meta.url)),
        offscreen: fileURLToPath(new URL('src/offscreen/index.html', import.meta.url)),
      },
      output: {
        chunkFileNames: 'assets/chunk-[hash].js',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
