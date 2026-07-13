/**
 * TauriFS — reads TL packages directly from the Tauri app's filesystem.
 *
 * For the Tauri target, the consumer ships the full TL TDS as app resources
 * (or copies it to AppData on first run). This backend lets the engine read
 * those files via @tauri-apps/plugin-fs — no OPFS, no per-file fetches, no
 * download flow.
 *
 * Usage:
 *
 *   import { createEngine } from 'texlive-wasm';
 *   import { withTauriFs } from 'texlive-wasm/tauri';
 *   import { BaseDirectory } from '@tauri-apps/plugin-fs';
 *
 *   const engine = await withTauriFs(
 *     (vfs) => createEngine('xelatex', { vfs }),
 *     { texmfRoot: 'texmf', baseDir: BaseDirectory.AppData },
 *   );
 */

import type { EngineHandle, VfsBackend } from '../core/types';
import { safeRelativePath } from '../core/paths';

export interface TauriFsOptions {
  /** Subdirectory under the chosen base dir where the TDS lives. e.g. "texmf". */
  texmfRoot: string;
  /**
   * Tauri BaseDirectory enum value. We accept it as a number to avoid a
   * hard dependency on @tauri-apps/api types here. Prefer importing
   * `BaseDirectory` from @tauri-apps/plugin-fs; for reference, Tauri 2
   * values are: Resource = 11, AppConfig = 13, AppData = 14,
   * AppLocalData = 15.
   */
  baseDir: number;
}

/**
 * Create a TauriFS backend. Imports @tauri-apps/plugin-fs dynamically so this
 * module doesn't pull it in for non-Tauri consumers.
 */
export async function createTauriFs(opts: TauriFsOptions): Promise<VfsBackend> {
  // Dynamic import — the plugin is a peerDependency.
  const fs = await import('@tauri-apps/plugin-fs').catch(() => null);
  if (!fs) {
    throw new Error(
      'texlive-wasm/tauri: @tauri-apps/plugin-fs is not installed. ' +
        'Add it as a dependency in your Tauri app.',
    );
  }

  // Unlike the other backends, a path that escapes here escapes into the
  // user's real filesystem: plugin-fs resolves it against a base dir with the
  // app's own permissions. Every TDS path arriving from an engine log goes
  // through the same funnel as everywhere else.
  const resolve = (tdsPath: string): string | null => {
    const rel = safeRelativePath(tdsPath);
    if (!rel) return null;
    const root = opts.texmfRoot.replace(/\/+$/, '');
    return root ? `${root}/${rel}` : rel;
  };

  return {
    id: 'taurifs',
    async read(tdsPath: string): Promise<Uint8Array | null> {
      const full = resolve(tdsPath);
      if (!full) return null;
      try {
        return await (fs as typeof import('@tauri-apps/plugin-fs')).readFile(full, {
          baseDir: opts.baseDir,
        });
      } catch {
        return null;
      }
    },
    async exists(tdsPath: string): Promise<boolean> {
      const full = resolve(tdsPath);
      if (!full) return false;
      try {
        return await (fs as typeof import('@tauri-apps/plugin-fs')).exists(full, {
          baseDir: opts.baseDir,
        });
      } catch {
        return false;
      }
    },
  };
}

/**
 * Detect whether the current runtime is a Tauri app. Cheap and safe to
 * call from anywhere (returns false in Node, browsers, web workers).
 */
export function isTauri(): boolean {
  const g = globalThis as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(g.__TAURI_INTERNALS__ || g.__TAURI__);
}

/**
 * Convenience: create an engine with TauriFS prepended to its backend list.
 *
 * Use this when the consumer wants the engine to read TDS files straight
 * from the bundled Tauri resources. The TauriFs backend is consulted first
 * (highest priority), so any file present locally wins over CDN fallback.
 *
 * The actual engine is constructed by the caller-supplied factory, which
 * receives the prepared backend chain. In practice the factory is just
 * `createEngine` from this package.
 */
export async function withTauriFs(
  factory: (vfs: VfsBackend[]) => Promise<EngineHandle>,
  opts: TauriFsOptions & { extraBackends?: VfsBackend[] },
): Promise<EngineHandle> {
  if (!isTauri()) {
    throw new Error('withTauriFs: not running in a Tauri app (window.__TAURI__ missing)');
  }
  const tauriFs = await createTauriFs(opts);
  return factory([tauriFs, ...(opts.extraBackends ?? [])]);
}
