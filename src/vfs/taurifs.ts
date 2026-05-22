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
 *
 *   const engine = await withTauriFs(
 *     await createEngine('xelatex', { manifestUrl: 'asset://texmf/manifest.json' }),
 *     { texmfRoot: 'texmf', baseDir: BaseDirectory.AppData },
 *   );
 */

import type { EngineHandle, VfsBackend } from '../core/types';

export interface TauriFsOptions {
  /** Subdirectory under the chosen base dir where the TDS lives. e.g. "texmf". */
  texmfRoot: string;
  /**
   * Tauri BaseDirectory enum value. We accept it as a number to avoid a
   * hard dependency on @tauri-apps/api types here. Common values:
   *   AppData = 9, AppLocalData = 10, AppConfig = 11, Resource = 19.
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

  const join = (a: string, b: string) =>
    a.endsWith('/') ? a + b.replace(/^\//, '') : a + '/' + b.replace(/^\//, '');

  return {
    id: 'taurifs',
    async read(tdsPath: string): Promise<Uint8Array | null> {
      const full = join(opts.texmfRoot, tdsPath);
      try {
        return await (fs as typeof import('@tauri-apps/plugin-fs')).readFile(full, {
          baseDir: opts.baseDir,
        });
      } catch {
        return null;
      }
    },
    async exists(tdsPath: string): Promise<boolean> {
      const full = join(opts.texmfRoot, tdsPath);
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
 * Wrap an existing engine handle and inject TauriFS into its backend chain.
 *
 * In the current skeleton the worker holds the backend list internally;
 * `withTauriFs` re-creates the engine with TauriFS prepended ahead of any
 * OPFS/FETCHFS layers. (Phase 1: implement the re-init plumbing.)
 */
export async function withTauriFs<T extends EngineHandle>(
  engine: T,
  _opts: TauriFsOptions,
): Promise<T> {
  // TODO(phase 2): plumb a runtime layer-injection API through worker.ts.
  // For now, log a hint and return the engine unchanged so the demo runs.
  // eslint-disable-next-line no-console
  console.warn(
    '[texlive-wasm/tauri] withTauriFs is a Phase 2 stub. ' +
      'Pass `vfs: [...]` to createEngine() to install TauriFS explicitly.',
  );
  return engine;
}

/**
 * Build-time helper: unpack the bundled "full" tarball into the Tauri
 * resources directory so it ships with the app.
 *
 * Invoked from the consumer's build pipeline (e.g. `tauri before-build`),
 * not from the running app. Lives in this file for discoverability; the
 * actual implementation is in scripts/build-bundle.ts.
 */
export async function prepareTauriResources(_opts: {
  /** Path to write the unpacked texmf/ tree into. */
  outDir: string;
  /** Source: 'core' (smaller) or 'full' (default). */
  tier?: 'core' | 'full';
}): Promise<void> {
  throw new Error(
    'prepareTauriResources: run `npx texlive-wasm prepare-resources` from your shell instead.',
  );
}
