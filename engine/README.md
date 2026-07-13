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

| Tool | Version | Pinned by |
|---|---|---|
| Debian base image | bookworm-slim | manifest digest (`Dockerfile`) |
| Emscripten | 5.0.7 | emsdk commit, asserted after clone (`Dockerfile`) |
| wasi-sdk | 33.0 | tarball sha256, verified before unpack (`Dockerfile`) |
| TL upstream branch | `branch2026` (commit `fb61589266`, "tl26 post-release") | submodule |
| Source tarballs (perl, libxml2, biber, XS dists) | see `scripts/biber/spike-build.sh` | sha256 via `scripts/fetch-verify.sh` |
| cpanminus + biber's pure-perl closure | 1.7049 + 65 dists | sha256 (`scripts/biber/cpan-lock.txt`) |

Nothing in the image or the biber build is fetched without a digest or a
sha256. The one exception is `apt-get install` in the Dockerfile, whose
packages are signed by the Debian archive key but not version-pinned: the
base-image digest fixes the snapshot they resolve against, not their versions.

`cpan-lock.txt` is the complete pure-perl dependency closure of biber, in
dependency order. Builds install exactly it, from a local mirror, with
`cpanm --mirror-only` — a dist that is missing from the lock cannot be
resolved at all, so the build fails instead of silently pulling an unpinned
tarball off CPAN. To change the dependency set, edit `CPAN_MODULES` in
`scripts/biber/spike-build.sh` and regenerate (needs network, maintainer-run):

```bash
bash scripts/biber/spike-build.sh cpan-lock   # rewrites cpan-lock.txt
```

## Status

All six engines (pdflatex, xelatex, lualatex, bibtexu, xdvipdfmx, makeindex)
build and pass their smoke tests for the emscripten target; pdflatex also
builds for wasi. See the status table in the repo-root `CLAUDE.md` and the
roadmap in `../plan.md`.
