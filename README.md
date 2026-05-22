# texlive-wasm

> ⚠ **Pre-alpha — under construction.** No usable build yet. See `plan.md` for the roadmap.

TeX Live compiled to WebAssembly. Runs pdfLaTeX, XeLaTeX, and LuaLaTeX in the browser, in a Tauri/Capacitor mobile app, in Node, or under Wasmtime on the edge — from the same C sources.

Designed offline-first for the **Tauri 2.0 + SolidJS + Vite** mobile-app use case, with a web/PWA fallback.

## Status

- Phase 0 — repo scaffolding ✅
- Phase 1 — `pdflatex.wasm` (Emscripten + WASMFS) 🚧
- Phase 2 — FETCHFS + OPFS + Tauri full-bundle 📋
- Phase 3 — `xelatex.wasm`, `lualatex.wasm` 📋
- Phase 4 — `latexmk` driver + SyncTeX 📋
- Phase 5 — wasi-sdk target + Wasmtime CLI 📋

See [`plan.md`](./plan.md) for the design and timeline.

## Quick links

- Design and roadmap: [`plan.md`](./plan.md)
- Reference implementations studied: [`example/busytex`](./example/busytex), [`example/texlyre-busytex`](./example/texlyre-busytex)
- Build the engines (long): `npm run engines:build`
- Build the manifest: `npm run manifest:build`

## License

MIT for the wrapper code in `src/`. The TeX engine artifacts ship with their own (LPPL, GPL family, etc.) — see the `NOTICE` file in each engine-artifact bundle.
