/*
 * wasmfs-lazy.c — lazy TDS tree via a WASMFS JSImpl backend.
 *
 * The worker keeps the TeX tree's bytes on the JS side (one decompressed
 * tar buffer + an offset index). Historically every fresh engine instance
 * copied ALL of it into MEMFS (~250 MB into the wasm heap per run); with
 * this backend only file NODES are created (cheap metadata) and the DATA
 * is copied into the heap on demand, read by read, from JS.
 *
 * JS contract (see wasmfs-lazy-lib.js and src/core/worker.ts):
 *  - Module.texliveLazyBackend must be set BEFORE texlive_mount_lazy() —
 *    it becomes the wasmFS$backends handler for this backend.
 *  - texlive_touch(path) creates one empty node; the handler pairs the
 *    resulting file id with the pending tar-index entry via allocFile().
 */
#include <emscripten/wasmfs.h>
#include <unistd.h>

void texlive_register_lazy_backend(backend_t backend);

static backend_t lazy_backend;

/* Mount the lazy tree at /texmf-dist. Returns 0 on success. */
int texlive_mount_lazy(void) {
  lazy_backend = wasmfs_create_jsimpl_backend();
  if (!lazy_backend) {
    return -1;
  }
  texlive_register_lazy_backend(lazy_backend);
  return wasmfs_create_directory("/texmf-dist", 0777, lazy_backend);
}

/* Create one empty file node in the lazy tree (data lives JS-side).
 * wasmfs_create_file returns an OPEN fd — close it or leak descriptors
 * across ~17k touches. Returns 0 on success. */
int texlive_touch(const char* path) {
  int fd = wasmfs_create_file(path, 0666, lazy_backend);
  if (fd < 0) {
    return fd;
  }
  close(fd);
  return 0;
}
