import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

// Tauri expects a fixed port and doesn't tolerate clearScreen.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [solid(), wasm(), topLevelAwait()],
  clearScreen: false,
  // The engines are single-threaded wasm — no COOP/COEP isolation needed,
  // which is what makes them viable inside mobile WebViews at all.
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: false,
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  optimizeDeps: {
    exclude: ['@typeward/texlive-wasm', '@tauri-apps/plugin-fs', '@tauri-apps/api'],
  },
});
