/**
 * Local glue around `texlive-wasm` for this Tauri example.
 *
 * In a web build the engine .wasm is fetched over HTTP from
 * /texlive-wasm/ (staged into public/ by scripts/ensure-assets.mjs) and
 * TDS files come from the same tree, drained on demand.
 *
 * In a Tauri build the same wrapper is reused, but a TauriFS backend is
 * prepended so the engine reads TDS files straight off disk via
 * @tauri-apps/plugin-fs — no network, no OPFS copy.
 */

import { createEngine, PdfLatex as _PdfLatex } from 'texlive-wasm';
import { withTauriFs, isTauri } from 'texlive-wasm/tauri';
import type { EngineConfig, EngineHandle, VfsBackend } from 'texlive-wasm';
import type { PdfLatexCompileOptions, RunResult } from 'texlive-wasm';

// BaseDirectory.Resource in Tauri 2 (@tauri-apps/api/path). Kept as a
// number so the web build doesn't import the Tauri API.
const TAURI_RESOURCE = 11;

class TauriAwarePdfLatex extends _PdfLatex {
  /** Resolves once the TauriFS-backed handle is attached (Tauri only). */
  private tauriInit: Promise<void> | null = null;

  constructor(config: EngineConfig & { texmfRoot?: string } = {}) {
    const { texmfRoot, ...cfg } = config;
    super(cfg);
    if (isTauri()) {
      // The TDS is bundled under $RESOURCE/texlive-wasm/texmf (see
      // tauri.conf.json bundle.resources).
      this.tauriInit = this.initTauriHandle(cfg, texmfRoot ?? 'texlive-wasm/texmf');
    }
  }

  override async compile(options: PdfLatexCompileOptions): Promise<RunResult> {
    // Wait for the TauriFS handle before the base class lazily creates a
    // plain one — otherwise the first compile races the backend setup.
    if (this.tauriInit) await this.tauriInit;
    return super.compile(options);
  }

  private async initTauriHandle(cfg: EngineConfig, texmfRoot: string): Promise<void> {
    const handle: EngineHandle = await withTauriFs(
      (vfs: VfsBackend[]) => createEngine('pdflatex', { ...cfg, vfs }),
      { texmfRoot, baseDir: TAURI_RESOURCE },
    );
    this.handle = handle;
  }
}

export const PdfLatex = TauriAwarePdfLatex;
export { isTauri };
export type { RunResult } from 'texlive-wasm';
