# demo/

SolidJS + Vite demo for `texlive-wasm`. Ready to drop into a Tauri 2.0 app.

## Run as a plain web app

```bash
npm install
npm run dev
# → http://localhost:1420
```

Vite serves with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` so SharedArrayBuffer-based
pthreads work for the engine workers.

## Run inside Tauri

This package doesn't ship a `src-tauri/` directory of its own — it's meant to
be merged into an existing Tauri 2.0 + SolidJS project. Two steps:

1. Add `texlive-wasm` and (optionally) `@tauri-apps/plugin-fs` to your app's
   dependencies.
2. In `src-tauri/tauri.conf.json`, set:

   ```json
   {
     "app": {
       "security": {
         "headers": {
           "Cross-Origin-Opener-Policy": "same-origin",
           "Cross-Origin-Embedder-Policy": "require-corp"
         }
       }
     }
   }
   ```

3. For full offline use, copy `node_modules/texlive-wasm/dist/bundles/full-*.tar.br`
   into `src-tauri/resources/` and unpack it on first launch (or use the helper
   `npx texlive-wasm prepare-resources <path-to-resources/texmf>`).
4. Wire the `TauriFS` backend:

   ```ts
   import { createEngine } from 'texlive-wasm';
   import { withTauriFs } from 'texlive-wasm/tauri';
   import { BaseDirectory } from '@tauri-apps/plugin-fs';

   const engine = await withTauriFs(
     await createEngine('xelatex', {
       manifestUrl: '/texmf/tex-packages.json',
     }),
     { texmfRoot: 'texmf', baseDir: BaseDirectory.Resource },
   );
   ```

## Status

Phase 0 — the demo compiles and runs, but `compile()` returns an empty PDF
until the Phase 1 `pdflatex.wasm` artifact lands.
