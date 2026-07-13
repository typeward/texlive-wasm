/**
 * FETCHFS — CDN long-tail backend.
 *
 * On a read miss in higher tiers, asks the CDN. Successful 200 responses are
 * reported via `onFetched` so a cache layer (e.g. OPFS) can write them
 * through — see defaultBackends() in vfs/index.ts.
 */

import type { VfsBackend } from '../core/types';
import { safeRelativePath } from '../core/paths';

export interface FetchFsOptions {
  cdnBaseUrl: string;
  /** Optional callback fired whenever a file is fetched (for cache write-through). */
  onFetched?: (tdsPath: string, bytes: Uint8Array) => void | Promise<void>;
  /**
   * Integrity gate. Given the TDS path and the fetched bytes, returns false to
   * reject them — the read then reports a miss rather than handing the engine
   * bytes a compromised CDN chose. See withIntegrity() in vfs/index.ts.
   */
  verify?: (tdsPath: string, bytes: Uint8Array) => Promise<boolean> | boolean;
}

export function createFetchFs(opts: FetchFsOptions): VfsBackend {
  const base = opts.cdnBaseUrl.endsWith('/') ? opts.cdnBaseUrl : opts.cdnBaseUrl + '/';

  return {
    id: 'fetchfs',
    async read(tdsPath: string): Promise<Uint8Array | null> {
      // TDS paths come straight out of engine logs; encode each segment and
      // refuse anything that could step outside the CDN base.
      const safePath = safeRelativePath(tdsPath);
      if (!safePath) return null;
      const url = base + safePath.split('/').map(encodeURIComponent).join('/');
      // Brotli pre-compression: the CDN serves files with Content-Encoding: br
      // and the browser decompresses natively. We just fetch the path as-is.
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`FETCHFS: HTTP ${r.status} for ${tdsPath}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (opts.verify && !(await opts.verify(safePath, buf))) return null;
      await opts.onFetched?.(tdsPath, buf);
      return buf;
    },
  };
}
