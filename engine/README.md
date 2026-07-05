# engine/

Build system for the TeX engine WASM artifacts. Independent from the
TypeScript wrapper — produces inputs that the wrapper consumes.

## Layout

- `Dockerfile` — pins Emscripten + wasi-sdk + system deps.
- `Makefile` — top-level driver. `make all` builds every engine for every target.
- `targets/{common,emscripten,wasi}.mk` — per-target compiler flags and link recipes.
- `patches/` — git patches applied to the TL submodule. See `patches/README.md`.
- `configs/mobile-strip.list` — paths excluded from mobile bundles.
- `source/texlive-source/` — symlink to `../vendor/texlive-source` (the submodule).

## Quick start (in CI or on a build box)

```bash
# Inside the repo root.
docker build -t texlive-wasm-builder engine/
docker run --rm -v "$PWD":/workspace -w /workspace/engine texlive-wasm-builder \
  make -j$(nproc) all dist
```

Build outputs land in `engine/build/<engine>/<target>/`; `make dist` stages
them into `engine/dist/<engine>/<target>/`. For local library work, copy them
into the repo-root `engine-artifacts/<engine>/<target>/` tree (that's where
the smoke tests and `scripts/pack-release.mjs` look). CI releases stage the
same layout automatically (`.github/workflows/release.yml`).

## Pinned versions

| Tool | Version |
|---|---|
| Emscripten | 5.0.7 |
| wasi-sdk | 33.0 |
| TL upstream branch | `branch2026` (commit `fb61589266`, "tl26 post-release") |

## Status

All six engines (pdflatex, xelatex, lualatex, bibtexu, xdvipdfmx, makeindex)
build and pass their smoke tests for the emscripten target; pdflatex also
builds for wasi. See the status table in the repo-root `CLAUDE.md` and the
roadmap in `../plan.md`.
