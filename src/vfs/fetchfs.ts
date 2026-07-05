/**
 * FETCHFS — CDN long-tail backend.
 *
 * On a read miss in higher tiers, asks the CDN. Successful 200 responses are
 * reported via `onFetched` so a cache layer (e.g. OPFS) can write them
 * through — see defaultBackends() in vfs/index.ts.
 */

import type { VfsBackend } from '../core/types';

export interface FetchFsOptions {
  cdnBaseUrl: string;
  /** Optional callback fired whenever a file is fetched (for cache write-through). */
  onFetched?: (tdsPath: string, bytes: Uint8Array) => void | Promise<void>;
}

export function createFetchFs(opts: FetchFsOptions): VfsBackend {
  const base = opts.cdnBaseUrl.endsWith('/') ? opts.cdnBaseUrl : opts.cdnBaseUrl + '/';

  return {
    id: 'fetchfs',
    async read(tdsPath: string): Promise<Uint8Array | null> {
      const safePath = sanitizeTdsPath(tdsPath);
      if (!safePath) return null;
      // Brotli pre-compression: the CDN serves files with Content-Encoding: br
      // and the browser decompresses natively. We just fetch the path as-is.
      const r = await fetch(base + safePath);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`FETCHFS: HTTP ${r.status} for ${tdsPath}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      await opts.onFetched?.(tdsPath, buf);
      return buf;
    },
  };
}

/**
 * TDS paths come straight out of engine logs — encode each segment and
 * refuse anything that could step outside the CDN base ('..', absolute
 * paths, '?'/'#' metacharacters).
 */
function sanitizeTdsPath(tdsPath: string): string | null {
  const segments = tdsPath.replace(/^\/+/, '').split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segments.map(encodeURIComponent).join('/');
}
