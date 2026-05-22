/**
 * texlive-wasm — public API.
 *
 * Three layers:
 *   1. Low level:  createEngine() → run() — direct argv invocation.
 *   2. Mid level:  Engine wrappers (PdfLatex, XeLatex, LuaLatex) — typed args.
 *   3. High level: latexmk() — multi-pass driver with auto bibtex/makeindex/rerun detection.
 *
 * The Tauri integration ('texlive-wasm/tauri') is a separate entry point so
 * web-only consumers don't pull in @tauri-apps/plugin-fs.
 */

export { createEngine } from './core/engine';
export { latexmk } from './latexmk';
export { PdfLatex } from './engines/pdflatex';
export { XeLatex } from './engines/xelatex';
export { LuaLatex } from './engines/lualatex';
export { Bibtexu } from './engines/bibtexu';
export { Makeindex } from './engines/makeindex';
export { Xdvipdfmx } from './engines/xdvipdfmx';
export { createSynctex } from './synctex';

export { loadManifest } from './core/manifest';

export type {
  EngineId,
  EngineConfig,
  EngineHandle,
  RunOptions,
  RunResult,
  FileInput,
  CompileResult,
  LogEntry,
  VfsBackend,
} from './core/types';

export type { LatexmkOptions, LatexmkResult } from './latexmk';

export type { TexPackagesManifest, ManifestEntry, ManifestTier } from './core/manifest';

export type { SynctexLookup, SynctexForwardHit, SynctexReverseHit } from './synctex';
