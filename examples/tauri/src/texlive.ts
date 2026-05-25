/**
 * Local glue around `texlive-wasm` for this Tauri example.
 *
 * In a web build we use the engine .wasm + a brotli-compressed TDS bundle
 * fetched over HTTP (served from /texlive-wasm/, see ensure-assets.mjs).
 *
 * In a Tauri build the same wrapper is reused, but a TauriFS backend is
 * prepended so the engine reads TDS files straight off disk via
 * @tauri-apps/plugin-fs — no network, no OPFS copy.
 */

import { createEngine, PdfLatex as _PdfLatex } from 'texlive-wasm';
import { withTauriFs, isTauri } from 'texlive-wasm/tauri';
import type { EngineConfig, EngineHandle, VfsBackend } from 'texlive-wasm';

const TAURI_RESOURCE = 19; // BaseDirectory.Resource enum value

class TauriAwarePdfLatex extends _PdfLatex {
  constructor(config: EngineConfig & { texmfRoot?: string } = {}) {
    super(config);
    if (isTauri()) {
      // Defer the actual handle creation until first compile() so we can
      // wrap it with TauriFS. The base class's lazy `ensureHandle()` will
      // call createEngine; intercept by pre-attaching a handle.
      void this.initTauriHandle({
        ...config,
        texmfRoot: config.texmfRoot ?? 'texlive-wasm',
      });
    }
  }

  private async initTauriHandle(
    config: EngineConfig & { texmfRoot: string },
  ): Promise<void> {
    const { texmfRoot, ...cfg } = config;
    const handle: EngineHandle = await withTauriFs(
      (vfs: VfsBackend[]) =>
        createEngine('pdflatex', { ...cfg, vfs }),
      { texmfRoot, baseDir: TAURI_RESOURCE },
    );
    // @ts-expect-error — assigning into the inherited protected field.
    this.handle = handle;
  }
}

export const PdfLatex = TauriAwarePdfLatex;
export { isTauri };
export type { RunResult } from 'texlive-wasm';
