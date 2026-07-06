# texlive-wasm

> Pre-alpha. The wrapper API and CLI are stable enough to build against; the
> engine release tarballs are produced from a hard fork of TeX Live 2026.

Run TeX Live in WebAssembly. Compiles LaTeX → PDF in the browser, in a
Tauri / Capacitor mobile app, in Node, and under Wasmtime on the edge —
from the same C sources, with one `.wasm` per engine.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Live demo](https://img.shields.io/badge/live%20demo-typeward.github.io%2Ftexlive--wasm-2f3e55)](https://typeward.github.io/texlive-wasm/)

**[Try it in your browser →](https://typeward.github.io/texlive-wasm/)** — all seven
engines, compiled client-side, no server.

## Engines

Built against [TeX Live 2026](https://www.tug.org/texlive/) (`branch2026`,
commit `fb61589266`):

| Engine          | Artifact                  | Size    | Status                                                                |
| --------------- | ------------------------- | ------- | --------------------------------------------------------------------- |
| pdfLaTeX        | `pdflatex.wasm`           | 1.3 MB  | compiles `\documentclass{article}` → PDF (2.4 KB) end-to-end          |
| XeLaTeX         | `xelatex.wasm`            | 2.8 MB  | instantiates; ICU 78.2 wired                                          |
| LuaLaTeX        | `lualatex.wasm`           | 4.8 MB  | LuaHBTeX 1.24.0 instantiates                                          |
| BibTeXu         | `bibtexu.wasm`            | 877 KB  | runs                                                                  |
| biber           | `biber.wasm` (+14 MB VFS) | 9.1 MB  | biber 2.19 on Perl 5.42 — `.bbl` output byte-identical to native      |
| xdvipdfmx       | `xdvipdfmx.wasm`          | 765 KB  | instantiates                                                          |
| makeindex       | `makeindex.wasm`          | 192 KB  | instantiates                                                          |
| pdfLaTeX (WASI) | `pdflatex.wasm` (wasi-sdk)| 2.0 MB  | Node / Wasmtime / edge — build locally; not in published releases yet |

SyncTeX is built into every engine. The JS parser in `src/synctex/`
currently extracts the input-file list; forward/reverse position lookup
is scheduled for Phase 4.

## Install

```bash
npm install texlive-wasm
```

The npm package ships only the JS/TS wrapper (`dist/`) and the CLI.
**Engine `.wasm` files are not in the package** — they live on GitHub
Releases as compressed tarballs. Fetch them in a postinstall step or on
first run:

```bash
# default → ./public/texlive-wasm/
npx texlive-wasm download-assets

# or specify a destination + pinned tag
npx texlive-wasm download-assets --tag v0.1.0-alpha.0 ./static/texlive

# or a subset (skip 100 MB of TDS if you ship your own); names match
# checksums.json keys, the .tar.gz/.gz suffix may be omitted
npx texlive-wasm download-assets --assets pdflatex-emscripten,icudt78l.dat
```

The CLI looks up `https://github.com/typeward/texlive-wasm/releases/download/<tag>/checksums.json`,
verifies SHA-256 of every downloaded blob against it, and unpacks the
`tar.gz` files into the destination.

Layout produced by `download-assets ./public/texlive-wasm/`:

```
public/texlive-wasm/
├── pdflatex/emscripten/pdflatex.{js,wasm,wasm.br,wasm.gz}
├── xelatex/emscripten/xelatex.{js,wasm,...}
├── lualatex/emscripten/lualatex.{js,wasm,...}
├── bibtexu/emscripten/bibtexu.{js,wasm,...}
├── xdvipdfmx/emscripten/xdvipdfmx.{js,wasm,...}
├── makeindex/emscripten/makeindex.{js,wasm,...}
├── icudt78l.dat          # ICU locale data (for xelatex + bibtexu)
└── texmf/                # core TDS slice (optional; ~360 MB unpacked)
```

## Usage

### Basic — one engine, one file

```ts
import { PdfLatex } from 'texlive-wasm';

const pdflatex = new PdfLatex({
  enginePath: '/texlive-wasm/pdflatex/emscripten/pdflatex.wasm',
});

const result = await pdflatex.compile({
  mainTex: 'main.tex',
  files: [
    {
      path: 'main.tex',
      content: String.raw`
        \documentclass{article}
        \begin{document}
        Hello from TeX Live on WebAssembly.
        \end{document}
      `,
    },
  ],
});

if (result.exitCode === 0) {
  const pdf = result.outputs.get('main.pdf')!;
  const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
  window.open(url);
} else {
  console.error(result.log);
}
```

### Multi-pass — bibtex + makeindex + rerun

```ts
import { latexmk } from 'texlive-wasm';

const out = await latexmk({
  engine: 'pdflatex',
  mainTex: 'paper.tex',
  files: [
    { path: 'paper.tex', content: source },
    { path: 'refs.bib', content: bibtex },
  ],
  bibtex: true,
  makeindex: true,
});
```

### Lower level — direct argv

```ts
import { createEngine } from 'texlive-wasm';

const engine = await createEngine('xelatex', {
  enginePath: '/texlive-wasm/xelatex/emscripten/xelatex.wasm',
  cdnBaseUrl: 'https://cdn.jsdelivr.net/npm/texlive-wasm-tlod@2026/dist/',
});

const r = await engine.run({
  args: ['-interaction=nonstopmode', '-halt-on-error', 'doc.tex'],
  files: [{ path: 'doc.tex', content }],
});
await engine.dispose();
```

## Tauri

`texlive-wasm/tauri` adds a `TauriFS` VFS backend that reads bundled
TeX Live resources directly from disk (no OPFS copy, no per-file fetch
overhead):

```ts
import { createEngine } from 'texlive-wasm';
import { withTauriFs, isTauri } from 'texlive-wasm/tauri';
import { BaseDirectory } from '@tauri-apps/plugin-fs';

const engine = await withTauriFs(
  (vfs) =>
    createEngine('xelatex', {
      vfs,
      enginePath: '/texlive-wasm/xelatex/emscripten/xelatex.wasm',
    }),
  { texmfRoot: 'texlive-wasm/texmf', baseDir: BaseDirectory.Resource },
);
```

A working SolidJS + Tauri 2.0 app is in [`examples/tauri/`](./examples/tauri/):

```bash
npm install
npm --prefix examples/tauri install
npm run tauri:dev
```

The example ships the engine + TDS as Tauri `resources`, so the resulting
installer is fully offline. See [`examples/tauri/README.md`](./examples/tauri/README.md).

## API surface

```ts
import {
  createEngine,            // low-level: createEngine(id, config) → run({ args, files })
  PdfLatex,
  XeLatex,
  LuaLatex,
  Bibtexu,
  Makeindex,
  Xdvipdfmx,
  latexmk,                 // multi-pass driver
  createSynctex,           // JS parser for .synctex(.gz) — file list today, lookups in Phase 4
  loadManifest,            // tex-packages.json reader
} from 'texlive-wasm';

import { withTauriFs, createTauriFs, isTauri } from 'texlive-wasm/tauri';
```

VFS chain (consulted in order on every read):

1. **BundleFS** — preloaded core TDS in memory.
2. **TauriFS** / **OPFS** — when running under Tauri or a browser PWA.
3. **FETCHFS** — last-resort CDN long-tail fetch.

You can pass a custom chain via `EngineConfig.vfs` to override the
default for tests or unusual deployments.

## Releasing

```bash
# 1. Build the engines (Docker required).
npm run engines:build

# 2. Pack release tarballs from engine-artifacts/.
npm run release:pack            # → release/*.tar.gz + checksums.json

# 3. Tag and push; .github/workflows/release.yml uploads the archives.
git tag v0.1.0-alpha.1
git push --tags
```

The release workflow is matrix-built per engine, packs via
`scripts/pack-release.mjs`, and attaches everything to the GitHub
Release. The `texlive-wasm` CLI then fetches from
`releases/download/<tag>/<asset>`.

## Layout

```
src/                  — TypeScript wrapper library (MIT)
  core/               — engine handles, manifest, worker bridge
  engines/            — typed wrappers for each engine
  vfs/                — BundleFS, OPFS, FETCHFS, TauriFS backends
  latexmk/            — multi-pass driver
  synctex/            — JS parser
  tauri.ts            — Tauri entry point
scripts/
  cli.cjs             — `npx texlive-wasm`
  pack-release.mjs    — bundle engine-artifacts/ into release/*.tar.gz
  ensure-assets.mjs   — used by examples
demo/                 — Vite + SolidJS showcase site (deployed to GitHub Pages)
examples/tauri/       — Tauri 2.0 + SolidJS example
engine/               — Docker-based engine build (Emscripten + wasi-sdk)
plan.md               — design notes & roadmap
```

## License

MIT for the wrapper code in `src/` and the CLI. Engine artifacts inherit
their upstream TeX Live licenses (LPPL, GPL, and friends) — see the
TeX Live LICENSE.TL bundled with each release.
