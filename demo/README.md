# demo/

SolidJS + Vite web demo for `texlive-wasm`. It drives `pdflatex.wasm`
directly (no worker wrapper) and renders the result with pdf.js.

## Prerequisites

The demo serves engine artifacts from the repo-root `engine-artifacts/`
tree at `/core/*`. Stage them first, from the repo root:

```bash
# either build them (Docker required)
npm run engines:build

# or download a published release
npx texlive-wasm download-assets ./engine-artifacts

# then fetch + pack the TDS slice the demo compiles against
bash scripts/fetch-tds.sh
node scripts/pack-tds.mjs        # → engine-artifacts/texmf.tar.{gz,br}
```

## Run

```bash
cd demo
npm install
npm run dev
# → http://localhost:1420
```

Vite serves with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` so SharedArrayBuffer-based
pthreads work for the engine. `npm run preview` applies the same headers
and middleware.

## Using texlive-wasm inside a Tauri app

See [`../examples/tauri/`](../examples/tauri/) for a complete, working
Tauri 2.0 + SolidJS example (bundled resources, `TauriFS` backend,
COOP/COEP headers via `app.security.headers`). The short version:

```ts
import { createEngine } from 'texlive-wasm';
import { withTauriFs } from 'texlive-wasm/tauri';
import { BaseDirectory } from '@tauri-apps/plugin-fs';

const engine = await withTauriFs(
  (vfs) => createEngine('pdflatex', { vfs, enginePath: '/texlive-wasm/pdflatex/emscripten/pdflatex.wasm' }),
  { texmfRoot: 'texlive-wasm/texmf', baseDir: BaseDirectory.Resource },
);
```

## Status

Working end-to-end: type LaTeX, click Compile, get a PDF rendered by
pdf.js — everything runs client-side.
