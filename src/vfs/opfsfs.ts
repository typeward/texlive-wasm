/**
 * OPFS-backed VFS — persistent cache for the "full" tier and CDN fetches.
 *
 * Browser layout under the OPFS root:
 *   texlive-wasm/
 *     manifest.json            (copied from the network manifest, pinned)
 *     full/                    (unpacked full-tier bundle)
 *       tex/latex/base/article.cls
 *       ...
 *     cdn/                     (cached long-tail fetches)
 *       tex/latex/some-rare/rare.sty
 *
 * Reads are async — that's fine because the worker uses Atomics.wait on a
 * SharedArrayBuffer to bridge the engine's synchronous I/O to our async
 * backend calls. (Handled in the WASMFS adapter, not here.)
 */

import type { VfsBackend } from '../core/types';

export interface OpfsFsOptions {
  /** Root directory name within OPFS. Default: "texlive-wasm". */
  rootName?: string;
  /** Manifest URL used for integrity checks. */
  manifestUrl?: string;
}

export async function createOpfsFs(opts: OpfsFsOptions): Promise<VfsBackend> {
  const rootName = opts.rootName ?? 'texlive-wasm';
  const root = await navigator.storage.getDirectory();
  // Ensure the top-level dirs exist.
  const tlRoot = await root.getDirectoryHandle(rootName, { create: true });
  const fullDir = await tlRoot.getDirectoryHandle('full', { create: true });
  const cdnDir = await tlRoot.getDirectoryHandle('cdn', { create: true });

  async function readFrom(
    dir: FileSystemDirectoryHandle,
    tdsPath: string,
  ): Promise<Uint8Array | null> {
    const parts = tdsPath.split('/').filter(Boolean);
    let cur: FileSystemDirectoryHandle = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      try {
        cur = await cur.getDirectoryHandle(seg, { create: false });
      } catch {
        return null;
      }
    }
    try {
      const fh = await cur.getFileHandle(parts[parts.length - 1]!, { create: false });
      const file = await fh.getFile();
      const ab = await file.arrayBuffer();
      return new Uint8Array(ab);
    } catch {
      return null;
    }
  }

  return {
    id: 'opfsfs',
    async read(tdsPath: string): Promise<Uint8Array | null> {
      // Check "full" first (preloaded full bundle), then the "cdn" cache.
      return (await readFrom(fullDir, tdsPath)) ?? (await readFrom(cdnDir, tdsPath));
    },
  };
}
