/*
 * wasmfs-lazy-lib.js — JS half of the lazy TDS backend (wasmfs-lazy.c).
 *
 * WASMFS JSImpl backends dispatch file ops through wasmFS$backends[id];
 * this registers the embedder-provided handler (Module.texliveLazyBackend,
 * set by src/core/worker.ts before calling _texlive_mount_lazy) under the
 * backend id the C side just created.
 */
addToLibrary({
  texlive_register_lazy_backend__deps: ['$wasmFS$backends'],
  texlive_register_lazy_backend: (backend) => {
    wasmFS$backends[backend] = Module['texliveLazyBackend'];
  },
});
