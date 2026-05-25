# texlive-wasm — Tauri 2.0 example

Minimal SolidJS + Tauri app that compiles LaTeX → PDF entirely on-device
using `texlive-wasm`. The bundled TeX Live tree (`pdflatex` engine + a
slice of TDS) is shipped as a Tauri resource and read through the
`TauriFS` VFS backend — no network requests at runtime.

## Run

From the repo root:

```bash
npm install              # install the wrapper library
npm --prefix examples/tauri install
npm run tauri:dev        # delegates to `tauri dev` inside this directory
```

The first run executes `scripts/ensure-assets.mjs`, which stages engine
artifacts into `public/texlive-wasm/` from one of:

1. `engine-artifacts/` (developer build, `npm run engines:build`)
2. A GitHub Release matching `package.json`'s version
   (`npx texlive-wasm download-assets`)

## What it does

- Loads `pdflatex.wasm` in a Web Worker via `texlive-wasm`'s
  `createEngine('pdflatex')`.
- When running inside Tauri (`window.__TAURI_INTERNALS__` present),
  prepends a `TauriFS` backend so TeX file reads hit the bundled resource
  directory directly through `@tauri-apps/plugin-fs`.
- Renders the resulting PDF in an `<iframe>` (the web build can swap in
  pdf.js if needed; the Tauri webview can render PDFs natively on most
  platforms).

## Production bundle

`npm run tauri:build` requires real app icons. Generate them once:

```bash
cd examples/tauri
npx tauri icon path/to/source.png
```

Then run `npm run tauri:build`. The resulting installer/AppImage ships
the engine + TDS as application resources.
