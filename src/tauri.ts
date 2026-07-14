/**
 * Tauri 2.0 integration entry point.
 *
 * Importing this module attaches a TauriFS VFS backend that reads TL packages
 * from the app's native filesystem via @tauri-apps/plugin-fs.
 *
 * Usage in a SolidJS + Tauri app:
 *
 *   import { createEngine } from '@typeward/texlive-wasm';
 *   import { withTauriFs } from '@typeward/texlive-wasm/tauri';
 *   import { BaseDirectory } from '@tauri-apps/plugin-fs';
 *
 *   const engine = await withTauriFs(
 *     (vfs) => createEngine('xelatex', { vfs }),
 *     { texmfRoot: 'texmf', baseDir: BaseDirectory.Resource },
 *   );
 */

export { createTauriFs, withTauriFs, isTauri } from './vfs/taurifs';
export type { TauriFsOptions } from './vfs/taurifs';
