# demo/ — the showcase site

SolidJS + Vite app deployed to **https://typeward.github.io/texlive-wasm/**.
It is the reference consumer of the `texlive-wasm` npm API: every compile
goes through `latexmk()` / `createEngine()` with one Web Worker per engine
(see `src/engine-manager.ts`) — no hand-rolled Emscripten driving.

Tabs demonstrate the full tour: live pdflatex editor, the XeLaTeX →
xdvipdfmx two-worker pipeline, LuaLaTeX with `\directlua`, bibliography via
BibTeXu, makeindex, multi-pass rerun, SyncTeX parsing, a sample gallery, and
an architecture page.

## Runtime assets

The app fetches everything from `core/` next to `index.html`:

```
core/
├── <engine>/emscripten/<engine>.{js,wasm}   # per engine, lazy
├── texmf.tar.gz                             # TeX tree incl. rebuilt .fmt files (tens of MB, set by fetch-tds.sh)
└── icudt78l.dat                             # ICU data (xelatex + bibtexu only, ~21 MB)
```

- **Dev / preview:** the vite middleware serves the repo-root
  `engine-artifacts/` at `/core/*`. Stage it once, from the repo root:

  ```bash
  npx texlive-wasm download-assets ./engine-artifacts   # or: npm run engines:build
  bash scripts/fetch-tds.sh
  node scripts/build-fmt.mjs
  node scripts/build-xelatex-fmt.mjs
  node scripts/build-lualatex-fmt.mjs
  node scripts/pack-tds.mjs
  ```

- **Production:** `.github/workflows/deploy-site.yml` does the same on CI
  (release assets + cached TDS) and copies the files into `dist/core/`
  after `vite build`.

## Run

```bash
npm run build            # repo root — the demo consumes the library via file:..
cd demo
npm install
npm run dev              # → http://localhost:1420
```

## No cross-origin isolation needed

The engines are single-threaded wasm (since v0.2.0-alpha) — no
SharedArrayBuffer, so no COOP/COEP headers and no service-worker shims.
Plain static hosting works, and dev/preview/production behave identically.
(Earlier releases were `-pthread` builds and needed a vendored
coi-serviceworker on GitHub Pages; that whole mechanism is gone.)

## Previewing the production build locally

```bash
npm run build
# stage assets exactly like the deploy workflow does:
for e in pdflatex xelatex lualatex bibtexu xdvipdfmx makeindex; do
  mkdir -p dist/core/$e/emscripten
  cp ../engine-artifacts/$e/emscripten/$e.{js,wasm} dist/core/$e/emscripten/
done
cp ../engine-artifacts/texmf.tar.gz ../engine-artifacts/icudt78l.dat dist/core/
npm run preview          # headers path (SW no-ops)
npx serve dist           # no-headers path (exercises the service worker)
```
