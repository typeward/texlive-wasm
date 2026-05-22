import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// Tauri expects a fixed port and no clearScreen.
const host = process.env.TAURI_DEV_HOST;

const ENGINE_ARTIFACTS = resolve(__dirname, '../engine-artifacts');

/**
 * Serve `../engine-artifacts/*` at `/core/*` during `vite dev`.
 * For production builds the consumer is expected to host the artifacts
 * themselves; this middleware exists just for `npm run dev`.
 */
function serveEngineArtifacts(): Plugin {
  return {
    name: 'serve-engine-artifacts',
    configureServer(server) {
      server.middlewares.use('/core', (req, res, next) => {
        const urlPath = (req.url ?? '/').split('?')[0];
        const filePath = resolve(ENGINE_ARTIFACTS, '.' + urlPath);
        if (!filePath.startsWith(ENGINE_ARTIFACTS)) {
          res.statusCode = 403;
          return res.end('Forbidden');
        }
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          return next();
        }
        const contentType = filePath.endsWith('.js')
          ? 'application/javascript'
          : filePath.endsWith('.wasm')
            ? 'application/wasm'
            : filePath.endsWith('.tar.gz')
              ? 'application/gzip'
              : filePath.endsWith('.tar.br')
                ? 'application/x-brotli'
                : 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        createReadStream(filePath).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [solid(), wasm(), topLevelAwait(), serveEngineArtifacts()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
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
