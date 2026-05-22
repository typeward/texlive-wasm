/**
 * Tauri 2.0 integration entry point.
 *
 * Importing this module attaches a TauriFS VFS backend that reads TL packages
 * from the app's native filesystem via @tauri-apps/plugin-fs.
 *
 * Usage in a SolidJS + Tauri app:
 *
 *   import { createEngine } from 'texlive-wasm';
 *   import { withTauriFs } from 'texlive-wasm/tauri';
 *
 *   const engine = await withTauriFs(
 *     createEngine('xelatex', { manifestUrl: '/texmf/manifest.json' }),
 *     { texmfRoot: 'texmf', baseDir: BaseDirectory.AppData },
 *   );
 */

export { withTauriFs, prepareTauriResources } from './vfs/taurifs';
export type { TauriFsOptions } from './vfs/taurifs';
