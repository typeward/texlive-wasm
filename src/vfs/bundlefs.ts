/**
 * BundleFS — serves a TL TDS subset that was preloaded into memory.
 *
 * The bundle is a gzip- or brotli-wrapped tar of `texmf-dist/*` paths. On
 * engine init we fetch it once, decompress via native DecompressionStream,
 * untar into a Map, and serve reads from RAM.
 *
 * - `bundleUrl` is fetched as bytes; the format ('gzip'/'br') is auto-detected
 *   from the URL extension or magic bytes.
 * - `manifestUrl` alone also works: the manifest's `coreBundleUrl` (resolved
 *   relative to the manifest) names the bundle to fetch.
 * - For Node/Tauri tests, callers can pass `bundleBytes` directly.
 */

import type { VfsBackend } from '../core/types';
import { loadManifest } from '../core/manifest';
import { decompress, untar } from './tar';

export interface BundleFsOptions {
  /** Manifest URL; its `coreBundleUrl` locates the bundle when `bundleUrl` is not given. */
  manifestUrl?: string;
  /** Explicit bundle URL override. */
  bundleUrl?: string;
  /** Pre-loaded bundle bytes (skip fetch). Useful for tests + Tauri resources. */
  bundleBytes?: Uint8Array;
  /**
   * Compression format. Default: auto-detect from bundleUrl suffix (`.gz`
   * / `.br`) or via magic-byte sniff on the bytes.
   */
  format?: 'gzip' | 'br';
  /**
   * Strip a leading path prefix from every entry. Default: `'texmf/'` (the
   * bundle produced by `scripts/pack-tds.mjs` nests everything under that).
   */
  stripPrefix?: string;
}

export async function createBundleFs(opts: BundleFsOptions): Promise<VfsBackend> {
  const files = new Map<string, Uint8Array>();
  const stripPrefix = opts.stripPrefix ?? 'texmf/';

  async function load(): Promise<void> {
    let bytes = opts.bundleBytes;
    let bundleUrl = opts.bundleUrl;
    if (!bytes && !bundleUrl && opts.manifestUrl) {
      const manifest = await loadManifest(opts.manifestUrl);
      if (manifest.coreBundleUrl) {
        bundleUrl = new URL(manifest.coreBundleUrl, absolutize(opts.manifestUrl)).toString();
      }
    }
    if (!bytes && bundleUrl) {
      const r = await fetch(bundleUrl);
      if (!r.ok) throw new Error(`BundleFs: HTTP ${r.status} for ${bundleUrl}`);
      bytes = new Uint8Array(await r.arrayBuffer());
    }
    if (!bytes) return;
    const format = opts.format ?? detectFormat(bundleUrl, bytes);
    const tar = format === 'raw' ? bytes : await decompress(bytes, format);
    for (const entry of untar(tar)) {
      if (entry.type !== 'file') continue;
      let path = entry.path;
      if (path.startsWith(stripPrefix)) path = path.slice(stripPrefix.length);
      files.set(path, entry.content);
    }
  }

  return {
    id: 'bundlefs',
    read(tdsPath: string): Uint8Array | null {
      return files.get(stripLeading(tdsPath)) ?? null;
    },
    exists(tdsPath: string): boolean {
      return files.has(stripLeading(tdsPath));
    },
    list(prefix: string): string[] {
      const p = stripLeading(prefix);
      const out: string[] = [];
      for (const path of files.keys()) {
        if (path.startsWith(p)) out.push(path);
      }
      return out;
    },
    async init() {
      await load();
    },
  };
}

function stripLeading(p: string): string {
  return p.replace(/^\/+/, '');
}

/** Make a possibly-relative manifest URL absolute so it can be a URL base. */
function absolutize(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const origin = typeof location !== 'undefined' ? location.href : 'file:///';
  return new URL(url, origin).toString();
}

export function detectFormat(url: string | undefined, bytes: Uint8Array): 'gzip' | 'br' | 'raw' {
  if (url) {
    if (url.endsWith('.tar.gz') || url.endsWith('.tgz')) return 'gzip';
    if (url.endsWith('.tar.br')) return 'br';
    if (url.endsWith('.tar')) return 'raw';
  }
  // gzip has magic bytes 1F 8B.
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
  // A plain tar has "ustar" at offset 257 of the first header block.
  if (
    bytes.length >= 262 &&
    bytes[257] === 0x75 && // u
    bytes[258] === 0x73 && // s
    bytes[259] === 0x74 && // t
    bytes[260] === 0x61 && // a
    bytes[261] === 0x72 // r
  ) {
    return 'raw';
  }
  // Brotli has no magic bytes — it's what's left.
  return 'br';
}
