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
        const requested = resolve(ENGINE_ARTIFACTS, '.' + urlPath);
        if (!requested.startsWith(ENGINE_ARTIFACTS)) {
          res.statusCode = 403;
          return res.end('Forbidden');
        }

        // Pre-compressed asset negotiation: if the client advertises br/gzip
        // and a sibling .br/.gz file exists, serve that with the appropriate
        // Content-Encoding header. Saves ~70% on .wasm transfer in the demo.
        const accept = (req.headers['accept-encoding'] as string | undefined) ?? '';
        const candidates = [
          accept.includes('br') ? { ext: '.br', enc: 'br' } : null,
          accept.includes('gzip') ? { ext: '.gz', enc: 'gzip' } : null,
        ].filter((x): x is { ext: string; enc: string } => x !== null);

        let filePath = requested;
        let encoding: string | null = null;
        for (const c of candidates) {
          const pre = requested + c.ext;
          if (existsSync(pre) && statSync(pre).isFile()) {
            filePath = pre;
            encoding = c.enc;
            break;
          }
        }

        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          return next();
        }
        const base = filePath.replace(/\.(br|gz)$/, '');
        const contentType = base.endsWith('.js')
          ? 'application/javascript'
          : base.endsWith('.wasm')
            ? 'application/wasm'
            : base.endsWith('.tar.gz')
              ? 'application/gzip'
              : base.endsWith('.tar.br')
                ? 'application/x-brotli'
                : base.endsWith('.dat')
                  ? 'application/octet-stream'
                  : 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        if (encoding) res.setHeader('Content-Encoding', encoding);
        res.setHeader('Content-Length', String(statSync(filePath).size));
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
