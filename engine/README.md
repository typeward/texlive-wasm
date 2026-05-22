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

Outputs land in `engine/dist/<engine>/<target>/`. The npm `prepack` step
copies them into `engine-artifacts/`.

## Pinned versions

| Tool | Version |
|---|---|
| Emscripten | 5.0.7 |
| wasi-sdk | 33.0 |
| TL upstream branch | `branch2025` |

## Phase 1 status

The Makefile structure is in place but the per-engine link recipes are stubbed.
The first real implementation target is `pdflatex-emscripten`. Track progress
in the project plan (`../plan.md`).
