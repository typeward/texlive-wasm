/**
 * BundleFS — serves a small "core" set of TL files preloaded into memory.
 *
 * The core bundle is a brotli-compressed tar (~20 MB) shipped with the npm
 * package. On engine init it's fetched, decompressed via the browser's native
 * DecompressionStream('deflate-raw' / 'gzip'... wait, see below), and read
 * into an in-memory `Map<tds-path, Uint8Array>`.
 *
 * Decompression note: browsers natively support gzip and deflate via
 * DecompressionStream, but not brotli. For brotli we use a tiny WASM decoder.
 * To keep this skeleton portable we accept either gzip or brotli, picked by
 * file extension or Content-Encoding.
 */

import type { VfsBackend } from '../core/types';

export interface BundleFsOptions {
  /** Manifest URL is used to find the bundle URL and verify integrity. */
  manifestUrl?: string;
  /** Optional explicit bundle URL override. */
  bundleUrl?: string;
}

export async function createBundleFs(_opts: BundleFsOptions): Promise<VfsBackend> {
  // TODO(phase 1): fetch bundleUrl (or manifest.coreBundleUrl), stream-decompress,
  // untar into an in-memory map. For now this is an inert empty backend.
  const files = new Map<string, Uint8Array>();

  return {
    id: 'bundlefs',
    read(tdsPath: string): Uint8Array | null {
      return files.get(tdsPath) ?? null;
    },
    exists(tdsPath: string): boolean {
      return files.has(tdsPath);
    },
    list(prefix: string): string[] {
      const out: string[] = [];
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) out.push(path);
      }
      return out;
    },
    async init() {
      // populate `files` here
    },
  };
}
