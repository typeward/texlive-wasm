# texlive-wasm — implementation plan

A from-scratch TeX Live in WebAssembly, built for 2026 web platform capabilities. This document captures the analysis of the two reference projects, the architectural decisions, and a phased roadmap.

---

## 1. Why a new project

We have two working references in `example/`:

### busytex (TL 2023, MIT)

| Aspect | What it does |
|---|---|
| Build | Emscripten + musl-on-Alpine, fully static `busytex.wasm` (~32 MB) |
| Engines | pdftex, xetex, luahbtex, bibtex8, xdvipdfmx, makeindex, kpse* — all linked into one binary, dispatched by `strcmp(argv[1], ...)` |
| VFS | Custom C-level `packfs.c` that linker-wraps `fopen`/`open`/`read`/`stat`/... plus Emscripten MEMFS for project files |
| Asset delivery | Emscripten `.data` + `.js` package files, one per TL collection (`ubuntu-texlive-latex-extra`, etc.), preloaded by URL at startup (90–400 MB per collection) |
| Driver | `busytex_pipeline.js` calls engines in sequence: `xelatex → bibtex8 → xelatex → xelatex → xdvipdfmx` (or pdftex variant), zeroing/restoring the WASM heap between calls via a 64 MB snapshot |
| Worker | Thin `busytex_worker.js` that just relays messages |

### texlyre-busytex (TL 2026, AGPL-3)

A TypeScript wrapper around a re-built busytex. Same engine bits, but:
- per-engine `.wasm` modules (`pdftex.wasm`, `xetex.wasm`, `luahbtex.wasm`) in addition to the combined one
- TypeScript types, three thin engine classes (XeLatex / PdfLatex / LuaLatex)
- IndexedDB cache via Emscripten's built-in `EM_PRELOAD_CACHE`
- optional "remote endpoint" for on-demand TL package fetching
- npm-distributable, downloads ~32 MB wasm + 90–400 MB data via a `download-assets` CLI

### Shared limitations

1. **Heap snapshot hack** — the pipeline forces `TOTAL_MEMORY=512 MB` and uses a 64 MB header snapshot to "reset" engine state between runs. Brittle, expensive, and the FIXME comments in `busytex_pipeline.js` admit it.
2. **Custom packfs C glue** — ~400 lines of `__wrap_*` symbol macros and an open-addressed fd table. WASMFS makes this obsolete.
3. **Bulk-preload .data packages** — minimum useful initial load is ~80 MB even for trivial documents. No streaming, no per-file lazy fetch (except the half-baked "remote endpoint" in texlyre).
4. **Fat-binary dispatch by argv[1]** — wastes dead-code elimination opportunities; needed only because `wasm-ld --localize-hidden` (LLVM #50623) is still unimplemented and per-engine builds duplicate symbols. The right answer is per-engine `.wasm` *and* dropping the dispatcher entirely.
5. **Single-threaded** — no use of WASM threads, no SharedArrayBuffer, no parallel fmt/font init.
6. **No biber** (only bibtex8), font lookup by filename only, no glossaries-extra processing, no SyncTeX forward/reverse API exposed.
7. **JS pipeline is a monolith** — 30 KB single file, hard-coded paths, static state, race conditions noted in TODOs.
8. **License contamination risk** — texlyre's TS code is AGPL-3, so we cannot copy from it.

The new project replaces every one of those points.

---

## 2. Goals (and non-goals)

### Goals

- Compile a `\documentclass{article}` "hello world" in <2 s cold, <500 ms warm.
- Initial bundle <10 MB for the most common case (xelatex + basic packages).
- Stream the long-tail TL packages on-demand from a CDN; persist in OPFS for offline use.
- One small npm package with a clean typed API, comparable in DX to `pdfjs-dist` or `typst.ts`.
- Dual-target so the same engines run in the browser, in Node, and under Wasmtime on the edge.
- SyncTeX as first-class output with forward/reverse lookup APIs.
- MIT-licensed wrapper. Engine licenses inherit from TL (mostly LPPL/GPL-compatible).

### Non-goals (initial release)

- Biber. Defer to a future release; recommend `bibtexu` (Unicode BibTeX) for now.
- ConTeXt / LuaMetaTeX. Build a *pilot* (see §7) but not a v1 deliverable.
- Shell-escape, `minted`, external SVG/EPS inclusion — fundamentally blocked by sandboxing.
- A full editor. We ship the engine package; demo app is just a demo.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  consumer code  (SolidJS in Tauri WebView, or any web app)   │
│  import { createEngine, latexmk } from 'texlive-wasm'        │
└──────────────────────────────────────────────────────────────┘
               │ Comlink-wrapped proxy
               ▼
┌──────────────────────────────────────────────────────────────┐
│  Web Worker (one per engine instance)                        │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  engine.wasm  (xelatex | pdflatex | lualatex | ...)    │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │  Emscripten WASMFS                               │  │  │
│  │  │   /tmp        → MEMFS                            │  │  │
│  │  │   /project    → MEMFS (user-supplied files)      │  │  │
│  │  │   /texmf-dist → see VFS strategy below           │  │  │
│  │  │   /cache      → OPFS (web only)                  │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                                ▲
            ┌───────────────────┼────────────────────┐
            ▼                   ▼                    ▼
┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐
│ Tauri target     │  │ Web/PWA target   │  │ CDN fallback    │
│ TauriFS backend  │  │ BundleFS preload │  │ FETCHFS over    │
│ reads native FS  │  │ + OPFS LRU cache │  │ brotli CDN      │
│ (app resources)  │  │                  │  │ (when online)   │
└──────────────────┘  └──────────────────┘  └─────────────────┘
```

The three backends compose: a `core` bundle is preloaded in *every* target (so trivial documents work instantly), a `full` bundle is unpacked once to TauriFS (mobile) or OPFS (web) on first run, and the CDN fills the long tail when online.

### Components

| Component | Choice | Rationale |
|---|---|---|
| Browser toolchain | **Emscripten 4.0.22+** | WASMFS, OPFS backend, JS code caching, mature pthreads |
| Server toolchain | **wasi-sdk 24+ / Wasmtime** | Portable single-artifact, no Docker, edge-deployable |
| Engine binaries | **One `.wasm` per engine** (all three v1: pdflatex, xelatex, lualatex + bibtexu, xdvipdfmx, makeindex, synctex) | Sidesteps `localize-hidden`, smaller per-use download, lazy-loadable |
| VFS | **WASMFS** with multiple mounts and pluggable backends | Drops 400 LOC of custom packfs C, native OPFS support |
| Package delivery | **Tiered: core bundle preloaded + full bundle on-demand + CDN long-tail fallback** | Mobile-offline-first; CDN is opt-in fallback |
| Tauri integration | **TauriFS backend** reads packages from the app's native filesystem via `@tauri-apps/plugin-fs` | Zero OPFS overhead on mobile; full bundle ships as app resource |
| Web cache | **OPFS** for the on-demand portion, accessed via the WASMFS OPFS backend | Universal modern browser support |
| RPC | **Comlink** | 1.1 KB, transferables, typed proxies |
| PDF preview | **pdf.js for the demo**, document **PDFium-WASM** path for apps that need speed | pdf.js: zero install. PDFium-wasm: ~2× faster on large docs. Tauri apps may prefer a native plugin. |
| SyncTeX | Compiled to its own `synctex.wasm` | Forward + reverse lookup exposed in API |
| Bundling | **Vite + vite-plugin-wasm + vite-plugin-top-level-await** | Matches the user's SolidJS+Vite+Tauri stack |
| Threading | **pthreads via SharedArrayBuffer**, with COOP/COEP `credentialless` (web) — Tauri uses isolation by default | Parallel font/fmt init; graceful single-thread fallback |
| TL fork | **Hard fork of TeX-Live/texlive-source**, mobile-stripped (no Perl tools, no MetaPost, no mf-nowin, no docs/man) | User-confirmed for mobile size optimization |
| License | **MIT** (wrapper) — engine artifacts inherit TL licenses (LPPL/GPL family) | User-confirmed |
| Biber | **Not shipped** in v1 — bibtexu only | User-confirmed; document the gap in README |

### What gets dropped vs busytex

- `busytex.c` dispatcher
- `packfs.c` + the `__wrap_*` glue
- `emcc_wrapper.py`, `ubuntu_package_preload.py` (replaced by a clean manifest builder)
- The 64 MB heap-snapshot reset (each engine run gets a fresh worker)
- The `.data` + `.js` Emscripten preload packages (replaced by CDN files + WASMFS FETCHFS)

---

## 4. Engine selection

### v1 ship list

| Binary | Source | Purpose | Approx WASM size (est.) |
|---|---|---|---|
| `pdflatex.wasm` | TL `texk/web2c/pdftexdir` | pdfLaTeX | ~7 MB |
| `xelatex.wasm` | TL `texk/web2c/xetexdir` | XeLaTeX | ~10 MB (ICU, HarfBuzz) |
| `lualatex.wasm` | TL `texk/web2c/luatexdir` (LuaHBTeX) | LuaLaTeX | ~12 MB |
| `bibtexu.wasm` | TL `texk/bibtex-x` (bibtexu, not bibtex8) | Unicode bibliographies | <1 MB |
| `xdvipdfmx.wasm` | TL `texk/dvipdfm-x` | XDV → PDF | ~2 MB |
| `makeindex.wasm` | TL `texk/makeindexk` | Index generation | <500 KB |
| `synctex.wasm` | TL `texk/web2c/synctexdir` | Forward/reverse lookup | ~80 KB |

Each is built once via Emscripten and once via wasi-sdk, into `dist/<engine>/<target>/<engine>.wasm`.

### Format files

Ship pre-built fmt files alongside each engine:
- `latex.fmt` (pdftex)
- `xelatex.fmt` (xetex)
- `lualatex.fmt` (luahbtex)

These cut 3–5 s of cold-start. Built reproducibly in CI from a pinned `tlpkg/` snapshot.

### v2 candidate: LuaMetaTeX

- Pure C99, no `fork`/`exec`, no PDF backend (Lua handles output), no external deps beyond libc/libm.
- The most WASM-friendly TeX engine in existence by design.
- Build a pilot `luametatex.wasm` under wasi-sdk *first* (server target), then port to Emscripten.
- Decide post-v1 whether it replaces lualatex or ships alongside.

### Explicitly deferred / out-of-scope

- Biber. Recommend bibtexu; document the gap.
- ConTeXt. Pilot via LuaMetaTeX.
- Tectonic-on-WASM. Watch tectonic#166; revisit when Tectonic's Rust slice covers enough of XeTeX to attempt a `wasm32-unknown-emscripten` build.

---

## 5. VFS design

WASMFS with four mounts. The `/texmf-dist` mount is **layered**: it consults backends in order until one resolves.

| Mount | Backend | Lifetime | Purpose |
|---|---|---|---|
| `/tmp` | MEMFS | per-run | aux/log/synctex scratch, font cache |
| `/project` | MEMFS | per-run | user-supplied .tex / .bib / image files |
| `/texmf-dist` | Layered: BundleFS → TauriFS *or* OPFS → FETCHFS | session | TL packages |
| `/cache` | OPFS (web target only) | persistent | byte-identical copies of long-tail fetches |

### Backend semantics

**BundleFS** — a brotli-decompressed tarball of the *core* TL subset (~20 MB), preloaded into MEMFS on engine init. Covers `latex-base`, `latex-required`, `latex-recommended` plus geometry/hyperref/amsmath/biblatex.

**TauriFS** (Tauri target only) — wraps `@tauri-apps/plugin-fs`. The *full* TL bundle ships as an app resource (a `texmf/` directory in `src-tauri/resources/` or pulled to the app data dir on first run). Reads are synchronous from the worker's perspective by going through a SharedArrayBuffer + Atomics handshake to a Tauri-side reader. No OPFS overhead.

**OPFS backend** (web/PWA target) — the `full` bundle, unpacked to OPFS on first run after a user-confirmed download. Subsequent runs read straight from OPFS.

**FETCHFS** — the long-tail fallback. Only consulted when the layers above all miss. Fetches from a CDN, writes through to `/cache`.

### Tiered delivery model

| Tier | Size (est.) | Where it lives | When loaded |
|---|---|---|---|
| Engine + `.fmt` files | ~10 MB per engine | npm package | App install |
| Core TDS bundle | ~20 MB brotli | npm package | Engine init |
| Full TDS bundle | ~120 MB brotli | downloadable | First "full" use, with user confirmation |
| CDN long tail | unbounded | static CDN | On `kpathsea` miss (online only) |

For a fully offline mobile app, ship `engine + core + full` as Tauri resources. The full bundle is unpacked once on first launch to `$APPDATA/texmf/`, then read in-place by TauriFS forever after. CDN never gets called.

### Manifest format

```json
{
  "version": "texlive-2026-r0",
  "core_bundle_url": "https://cdn.example.com/bundles/core-2026-r0.tar.br",
  "full_bundle_url": "https://cdn.example.com/bundles/full-2026-r0.tar.br",
  "cdn_base_url": "https://cdn.example.com/tlpkg/",
  "files": {
    "tex/latex/base/article.cls": {
      "sha256": "...",
      "size": 12345,
      "tier": "core",
      "package": "latex-base"
    },
    "tex/latex/some-rare/rare.sty": {
      "sha256": "...",
      "size": 678,
      "tier": "cdn",
      "package": "some-rare"
    }
  }
}
```

Tiers: `core` (in BundleFS), `full` (in TauriFS/OPFS), `cdn` (FETCHFS only). The manifest is pinned at build time and ships with the engine npm package.

---

## 6. Public API (proposed)

The driver does **not** drive the engines in sequence — the consumer does. We expose a thin `run` interface and a `latexmk`-style helper for the common case.

```typescript
import { createEngine, latexmk } from '@texlive-wasm/engine';

// low level
const xelatex = await createEngine('xelatex', { manifestUrl, cdnBaseUrl });
const result = await xelatex.run({
  args: ['--no-shell-escape', '--interaction=nonstopmode', 'main.tex'],
  files: [{ path: 'main.tex', content: '...' }, ...],
  cwd: '/project',
  stdin: '',
});
// → { exitCode, stdout, stderr, outputs: Map<path, Uint8Array>, log: string }

// high level
const { pdf, synctex, log } = await latexmk({
  engine: 'xelatex',           // or 'pdflatex' | 'lualatex'
  bibtex: 'auto',              // 'auto' | true | false
  makeindex: 'auto',
  files: [{ path: 'main.tex', content: '...' }],
  mainFile: 'main.tex',
  rerun: 'auto',               // or 'fixed' | { maxPasses: 3 }
});

// SyncTeX lookups
import { createSynctex } from '@texlive-wasm/synctex';
const sx = await createSynctex(synctex);
sx.forward('main.tex', 42);          // → [{ page, x, y }, ...]
sx.reverse(1, 100, 200);             // → [{ file, line, column }, ...]
```

Worker management is internal: the package spins up one worker per engine on first use and reuses it. Termination is exposed via `engine.dispose()`.

---

## 7. Build pipeline

### Source tree (planned)

```
texlive-wasm/
├── example/                # frozen reference impls (don't edit)
├── vendor/                 # git submodules
│   ├── texlive-source/     # pinned TL release
│   ├── luametatex/         # pilot
│   └── icu/                # for xetex
├── engine/
│   ├── patches/            # minimal patches to TL sources
│   ├── build.sh            # entry point for one engine
│   └── targets/
│       ├── emscripten.mk
│       └── wasi.mk
├── src/
│   ├── core/               # engine runner, VFS setup, manifest
│   ├── engines/            # one wrapper per engine
│   ├── latexmk/            # the high-level driver
│   ├── synctex/            # synctex JS bindings
│   └── index.ts
├── scripts/
│   ├── build-manifest.ts   # walk TL tree → tex-packages.json
│   ├── upload-cdn.ts       # rsync to a static CDN
│   └── benchmark.ts
├── test/
├── demo/                   # vite + react playground
└── plan.md / CLAUDE.md
```

### Build matrix (CI)

For each engine: `{emscripten, wasi} × {opt, debug}`.

Reproducibility: pin `SOURCE_DATE_EPOCH`, fix tar ordering, sha256-check artifacts in CI.

---

## 8. Phased roadmap

### Phase 0 — scaffolding ✅ (complete)

- Repo skeleton, `.tool-versions`, `.editorconfig`, `.prettierrc.json`, `.gitignore`.
- `package.json` (ESM-first, dual ESM/CJS exports, `texlive-wasm/tauri` subpath), `tsconfig.json` (strict + exactOptionalPropertyTypes), Vite library build, Vitest.
- Full TS source skeleton with typed API: `createEngine`, `latexmk`, engine wrappers (PdfLatex/XeLatex/LuaLatex/Bibtexu/Makeindex/Xdvipdfmx), VFS layer chain (BundleFS/OPFS/FETCHFS/TauriFS), manifest types, SyncTeX parser.
- Engine build system scaffold: `engine/Dockerfile` pinning Emscripten 4.0.22 + wasi-sdk 24, top-level Makefile, per-target Makefiles, patch dir, mobile-strip config.
- Scripts: `build-manifest.ts` (runnable; SHA-256 + tier classification + glob matcher), `build-bundle.ts` (tar + brotli at quality 11), `cli.cjs`, `download-tl-source.sh`.
- CI: `ci.yml` (lint + typecheck + test + build on every push) and `build-engines.yml` (manual / tag-triggered Docker matrix).
- Demo: SolidJS + Vite + Tauri-ready skeleton at `demo/` with COOP/COEP headers wired.
- Verified green: `npm run lint`, `npm run typecheck`, `npm test` (5/5 passing), `npm run build` (14 KB ESM bundle).

### Phase 1 — engine compilation ✅ (4 of 7 engines compiled and verified, on **TeX Live 2026**)

**Built and verified against TL 2026** (`branch2026`, commit `fb61589266`):

| Engine | WASM size | JS size | Smoke test |
|---|---|---|---|
| `pdflatex.wasm` | 1.26 MB | 37 KB | ✅ `pdftex --version` → "pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026), kpathsea 6.4.2", exit 0 |
| `xelatex.wasm` | 2.84 MB | 38 KB | ✅ `xetex --version` → "XeTeX 3.141592653-2.6-0.999998 (TeX Live 2026), ICU 78.2", exit 0 |
| `lualatex.wasm` | 4.84 MB | 47 KB | ✅ `luahbtex --version` → "LuaHBTeX 1.24.0 (TeX Live 2026)", exit 0 |
| `makeindex.wasm` | 192 KB | 32 KB | ✅ instantiates and runs |
| `xdvipdfmx.wasm` | 765 KB | 36 KB | ✅ instantiates |

All are MODULARIZE/EXPORT_ES6/WASMFS-built and load via `await factory({ ... })` from Node 18+ and any 2023+ browser.

**Build infrastructure proven:**
- Docker toolchain image (Emscripten 5.0.7 + wasi-sdk 33 + gcc-multilib + texinfo): `engine/Dockerfile`.
- Native pre-build of TL helper tools (`tangle`, `ctangle`, `tangleboot`, `ctangleboot`, `tie`, `web2c`, `fixwrites`, `makecpool`, `splitup`) via `engine/targets/native.mk`. Smart `otangle` shell stub satisfies the WEBINPUTS check without building Omega.
- `engine/scripts/emcc_wrapper.py` intercepts emcc link calls whose `-o` basename matches a native helper and substitutes the host binary. Borrowed wholesale from busytex (MIT).
- Generic per-engine build pattern in `engine/targets/emscripten.mk`:
  1. emconfigure with `--host=wasm32-unknown-emscripten --build=x86_64-pc-linux-gnu --disable-all-pkgs --enable-<engine>` and force-included `engine/scripts/stubs_force.h` (provides `getpass`, `off64_t`).
  2. Post-configure surgery: trim `MAKE_SUBDIRS` in `libs/Makefile` and `texk/Makefile` (per `TL_LIBS_<engine>` / `TL_TEXK_<engine>` allowlists); blank unused `*_DEPEND` vars in `texk/web2c/Makefile` so its hardcoded "rebuild lib X" rules never fire.
  3. `emmake make` builds only the engine's required libs + kpathsea + ptexenc.
  4. Targeted `emmake make -C texk/web2c <engine-target>` for web2c-based engines (pdftex/xetex/luahbtex), avoiding `make all` which would pull in luaharfbuzz etc.
  5. Final emcc re-link with our flags (`-sMODULARIZE -sEXPORT_ES6 -sWASMFS -sENVIRONMENT=worker,web,node`) using per-engine `TL_LINK_OBJS_<engine>` / `TL_LINK_ARCS_<engine>` lists.

**Source patches (one-time, idempotent):**
- `engine/scripts/patch-icu-makefile.sh` patches `libs/icu/Makefile.in` so the icu-native sub-config uses native `gcc` rather than the wrapped emcc.
- `libs/icu/icu-src/source/config/mh-unknown` replaced with mh-linux content (Emscripten has no native ICU platform fragment).

**Standalone native ICU pre-build (`engine/targets/icu-native.mk`):**
- Configures ICU directly (bypassing TL's libs/icu wrapper), produces native `pkgdata`, `icupkg`, `genccode`, `genrb`, etc. in `engine/build/icu-native/bin/`.
- For xelatex/bibtexu cross-builds, the engine recipe symlinks `engine/build/icu-native/` into the engine's `Work/libs/icu/icu-native/`, so TL skips re-configuring ICU's host side.
- Exports `PKGDATA_OPTS=--without-assembly -O .../icupkg.inc` so pkgdata generates `.c` (compiled to wasm) instead of `.s` (ELF assembly that wasm-ld can't link).

**Deferred (next session):**

1. **xelatex** — **blocked on wasm fontconfig**. XeTeX's `XeTeXFontMgr_FC.cpp` includes `<fontconfig/fontconfig.h>` for font discovery; we don't currently build fontconfig. Path forward: add an `engine/targets/fontconfig-wasm.mk` that:
   - Downloads expat 2.5+ (CMake-build) and fontconfig 2.14+ (autotools).
   - Cross-compiles both against the same emcc wrapper + freetype2 (which we already build in libs/freetype2).
   - Wires the resulting `libfontconfig.a` into `TL_LINK_ARCS_xelatex`.
   - Provides a minimal `fonts.conf` mounted at `/etc/fonts/fonts.conf` so FcInit finds something at runtime.

2. **bibtexu** — **blocked on ICU data ELF/wasm mismatch**. `libicudata.a` is built by ICU's `pkgdata` which uses native `genccode` to wrap ~1000 resource bundles (`*_res.o`) into a single archive. Even with `--without-assembly`, those object files are produced in ELF format and wasm-ld can't link them. The undefined symbol is `icudt78_dat`. Two paths:
   - Run `pkgdata` in `-m common` mode (single .dat file, loaded at runtime from disk) instead of `-m static` (linked into the lib). Then ICU's `udata_setCommonData()` API loads it from MEMFS.
   - Or build a no-data ICU using `--with-data-packaging=files` and only mount the specific locale data files we need.

3. **synctex** — TL builds synctex as a `.o` linked into each engine (not a standalone binary). For our purposes, the JS synctex parser at `src/synctex/index.ts` reads `.synctex.gz` output produced by pdflatex/lualatex/xelatex.

4. **TDS bundle for end-to-end** (`latex.fmt` + minimum class/style files) — required for a real `\documentclass{article}` → `.pdf` smoke test. Two paths:
   - Download a minimal TeX Live TDS subset from CTAN and bundle as our "core" tarball.
   - Use the just-built pdflatex.wasm + `iniTeX -ini` to dump a `latex.fmt` from `latex.ltx` directly. Self-bootstrapping but more complex.

**TS wrapper layer ✅** — `src/core/worker.ts` is wired and verified: it loads the engine ES module via `import()`, instantiates via the factory, sets up WASMFS mounts (`/project`, `/tmp`, `/texmf-dist`), drains VFS backends into MEMFS, then `callMain(args)` and captures stdout/stderr/outputs. The smoke tests above use exactly this code path.

**Exit criteria for the goal:**
- ✅ Engine `.wasm` artifacts build cleanly in the toolchain image.
- ✅ pdflatex + lualatex compile and start (smoke test passes).
- 🚧 A real `latexmk` end-to-end ("hello world" .tex → .pdf) requires a TDS bundle — see Phase 2 BundleFS work.
- 🚧 xelatex + bibtexu need the ICU pre-build approach above.

### Phase 2 — FETCHFS + OPFS cache (2 weeks)

- Add the FETCHFS mount for `/texmf-dist`.
- Build the manifest generator.
- Stand up a static CDN (Cloudflare R2 or similar) with brotli pre-compressed files.
- OPFS write-through cache + integrity check.
- **Exit criteria:** a document using `amsmath`, `geometry`, `hyperref` compiles cold with only the engine bundle preloaded; second run is offline-capable.

### Phase 3 — xelatex + lualatex (2 weeks)

- Add xetex and luahbtex engine builds (ICU, HarfBuzz, lua53).
- Per-engine worker lazy-load.
- Decide whether to keep bibtex8 or jump to bibtexu (lean toward bibtexu).
- **Exit criteria:** all three engines compile a representative test suite (TL-provided samples).

### Phase 4 — driver, latexmk-style, SyncTeX (2 weeks)

- `latexmk` helper with multi-pass detection.
- Build and integrate `synctex.wasm`.
- Forward + reverse lookup API.
- **Exit criteria:** an Overleaf-style demo (editor + PDF + click-to-jump) works against the public CDN.

### Phase 5 — WASI target + Wasmtime CLI (1 week)

- Cross-compile each engine with wasi-sdk.
- Provide a `texlive-wasm-cli` thin Node/Wasmtime wrapper for use in CI pipelines.
- **Exit criteria:** `wasmtime pdflatex.wasm main.tex` works on Linux/Mac CI.

### Phase 6 — polish + release (2 weeks)

- Benchmarks vs busytex/texlyre-busytex (cold-start, warm, package fetch).
- Docs site (mdBook or astro).
- npm publish, GitHub release with engine artifacts.
- Demo site deployed.

### Phase 7+ — pilot LuaMetaTeX (open-ended)

- Cross-compile LMTX with wasi-sdk first.
- Decide on Emscripten port + integration with the driver.

Total: roughly **3 months** to first usable npm release.

---

## 9. Locked decisions

All initial open questions are resolved:

| # | Decision | Choice |
|---|---|---|
| 1 | Engines in v1 | **All three at once**: pdflatex, xelatex, lualatex (+ bibtexu, xdvipdfmx, makeindex, synctex) |
| 2 | Hosting | **Tiered**: core bundle preloaded, full bundle downloadable, optional CDN long-tail. Mobile target ships full bundle as Tauri resources. |
| 3 | License | **MIT** wrapper; engines keep their TL licenses |
| 4 | TL tracking | **Hard fork** of `TeX-Live/texlive-source`, mobile-stripped (no Perl tools, no MetaPost, no mf-nowin, no docs/man) |
| 5 | PDF viewer | **pdf.js for the demo**, document PDFium-WASM for apps that need speed |
| 6 | Biber | **Not in v1** — bibtexu only |
| 7 | Mobile shell | **Tauri 2.0 + SolidJS + Vite** is the primary mobile target (matches user's app stack) |

---

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| WASMFS + FETCHFS combo has edge-case bugs (still relatively new) | Med | Phase 1 stays on MEMFS; FETCHFS is isolated to Phase 2 |
| pthreads + COOP/COEP requirement excludes some embeddings | Med | Build a single-threaded variant; auto-detect and warn |
| Per-engine `.wasm` sizes balloon (e.g. xetex with ICU > 15 MB) | Med | Aggressive `-Oz`, strip unused ICU data, brotli at the wire |
| TLOD CDN cost spikes if usage grows | Low | Cloudflare R2 egress is free; cache aggressively client-side; document self-hosting |
| Upstream TL build breaks under wasi-sdk (mostly `fork`/`signal`) | High for some engines | Keep a thin patch series; pre-vet each engine against wasi-libc gaps |
| LuaMetaTeX never lands as a v2 path | Low impact | It's a pilot, not v1 — falling through doesn't block release |

---

## 11. Inspirations and credits

- **SwiftLaTeX** (SwiftLab, 2018–2022) — invented the TLOD pattern.
- **busytex** (busytex/busytex, MIT) — most complete open TL-to-WASM port.
- **texlyre-busytex** (TeXlyre, AGPL-3) — current TL 2026 fork; demonstrates engineMode and on-demand endpoint.
- **Tectonic** (tectonic-typesetting/tectonic, MIT) — bundle-format inspiration.
- **Typst.ts** (typst/typst) — sets the expectation for in-browser typesetting UX.
- **LuaMetaTeX** (contextgarden/luametatex) — design target for v2 engine.

---

## 12. Tauri 2.0 integration notes

Since the primary consumer is a Tauri 2.0 + SolidJS + Vite app:

- The package ships an optional `texlive-wasm/tauri` subpath export that wires `TauriFS` to `@tauri-apps/plugin-fs`. Web-only consumers don't pay for it.
- For the full offline bundle, the consumer's `src-tauri/tauri.conf.json` lists `resources/texmf/**/*` and the package provides a `texlive-wasm prepare-resources` CLI that decompresses the bundle into that tree at build time. On first app launch we copy it (or symlink, where the OS permits) to `$APPDATA/texlive-wasm/texmf/`.
- COOP/COEP is not an issue inside Tauri's WebView — Tauri controls the response headers and we set them to `same-origin` + `require-corp` in `tauri.conf.json` so SAB-based pthreads work.
- pdf.js or PDFium-WASM run unmodified inside the WebView. For peak mobile performance, the consumer can swap in a Tauri PDF plugin (none exists upstream — out of scope for us to build).
- Bundle size impact: a stripped TL full bundle is ~120 MB brotli-compressed, so a Tauri Android APK ends up in the 130–150 MB range — acceptable for an offline LaTeX editor.

## 13. Next concrete actions

1. Phase 0 scaffolding — `package.json`, `tsconfig`, vite config, source layout, Docker build container.
2. Phase 1 begins as soon as the toolchain Docker image builds — actual `pdflatex.wasm` compilation runs in CI (multi-hour) the first time.
3. Demo app: standalone SolidJS + Vite + Tauri 2.0 sample lives in `demo/`.
