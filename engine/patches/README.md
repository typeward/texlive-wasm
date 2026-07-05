# TL fork patches

Mobile-targeted patches applied on top of the upstream `texlive-source` tag.

## What we patch

1. **Mobile strip** — remove docs/man pages, Babel hyphenation patterns for
   languages we don't ship, MetaPost, Metafont (`mf-nowin`), `xindy`, perl
   support tools.
2. **Engine portability** — replace `fork(` / `system(` / `popen(` calls in
   kpathsea and the TeX engines with stubs that fail cleanly (we don't have
   processes in WASM/WASI).
3. **`localize-hidden` workaround** — until LLVM #50623 ships, prefix engine
   entry points with `busymain_<engine>_` and drop the duplicate `main`/global
   symbol exports.
4. **WASMFS-friendly path normalization** — small kpathsea tweak so it doesn't
   double-resolve `/texmf-dist//tex/latex/...` against TEXMF roots.
5. **SyncTeX always-on** — TL ships SyncTeX disabled by default in some
   configurations; we force-enable it so our viewer can use it.

## Convention

- One patch per concern. Filename: `NN-short-description.patch` (NN = apply order).
- Generated with `git format-patch -1`.
- When the first `.patch` file lands here, wire a `git -C source/texlive-source
  apply` loop into `engine/Makefile`'s `source` target (not implemented yet —
  there is nothing to apply).

## Status

No `.patch` files yet. The two source tweaks we currently need are applied
inline by the Makefile's `source` target instead: `scripts/patch-icu-makefile.sh`
(ICU data packaging) and the `mh-unknown` → `mh-linux` copy for the
wasm32-emscripten host triple. Diffs against upstream land here as real patch
files when we hit further porting issues.
