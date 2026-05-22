/**
 * VFS layer chain — defaults and helpers.
 *
 * The layer chain is consulted in order on every read; the first non-null
 * answer wins. This lets us put the cheapest backends first (BundleFS, then
 * cached layers, then network).
 */

import type { EngineConfig, EngineId, VfsBackend } from '../core/types';
import { createBundleFs } from './bundlefs';
import { createOpfsFs } from './opfsfs';
import { createFetchFs } from './fetchfs';

/**
 * Build the default backend chain for an engine instance.
 *
 * Order: BundleFS (in-memory core) → OPFS (when in a browser/PWA) → FETCHFS (CDN fallback).
 *
 * The TauriFS backend is *not* installed by default — the consumer opts in via
 * `withTauriFs(...)` from the `texlive-wasm/tauri` entry. That keeps web
 * consumers from picking up a hard dep on @tauri-apps/plugin-fs.
 */
export async function defaultBackends(_id: EngineId, config: EngineConfig): Promise<VfsBackend[]> {
  const layers: VfsBackend[] = [];

  // Always at least try BundleFS — even an "empty" core bundle keeps the
  // engine from immediately falling through to the network on every read.
  if (config.manifestUrl) {
    layers.push(await createBundleFs({ manifestUrl: config.manifestUrl }));
  }

  if (isOpfsAvailable()) {
    layers.push(await createOpfsFs(config.manifestUrl ? { manifestUrl: config.manifestUrl } : {}));
  }

  if (config.cdnBaseUrl) {
    layers.push(createFetchFs({ cdnBaseUrl: config.cdnBaseUrl }));
  }

  return layers;
}

function isOpfsAvailable(): boolean {
  // OPFS lives on navigator.storage.getDirectory(), available in workers.
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function'
  );
}

export { createBundleFs } from './bundlefs';
export { createOpfsFs } from './opfsfs';
export { createFetchFs } from './fetchfs';
