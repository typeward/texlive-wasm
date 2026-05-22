import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

// Tauri expects a fixed port and no clearScreen.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [solid(), wasm(), topLevelAwait()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    // SAB / pthreads require cross-origin isolation. The Tauri WebView
    // honors these headers when set in tauri.conf.json; for `vite dev` in
    // the browser we set them here too.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    watch: {
      ignored: ['**/src-tauri/**'],
    },
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
    exclude: ['texlive-wasm', '@tauri-apps/plugin-fs', '@tauri-apps/api'],
  },
});
