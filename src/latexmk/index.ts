/**
 * latexmk-style driver — multi-pass orchestration.
 *
 * Re-implements the small subset of latexmk's logic we actually need:
 *   1. Run the TeX engine.
 *   2. If `bibtex: 'auto'` and the document contains `\bibliography{…}` or
 *      `\printbibliography`, run bibtexu against the .aux.
 *   3. If `makeindex: 'auto'` and an .idx was produced, run makeindex.
 *   4. Re-run the TeX engine until `.aux` stabilizes (max 4 passes) or until
 *      no "Rerun to get cross-references right" message appears in the log.
 *   5. For xelatex, run xdvipdfmx on the resulting .xdv.
 *   6. Collect outputs (.pdf, .synctex.gz, .log).
 *
 * Single source of truth for the compile pipeline. Engine wrappers (PdfLatex,
 * XeLatex, LuaLatex) handle individual invocations.
 */

import type { CompileResult, EngineHandle, FileInput, LogEntry } from '../core/types';
import { PdfLatex } from '../engines/pdflatex';
import { XeLatex } from '../engines/xelatex';
import { LuaLatex } from '../engines/lualatex';
import { Bibtexu } from '../engines/bibtexu';
import { Makeindex } from '../engines/makeindex';
import { Xdvipdfmx } from '../engines/xdvipdfmx';

export type LatexmkEngine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface LatexmkOptions {
  engine: LatexmkEngine;
  mainTex: string;
  files: FileInput[];
  /** 'auto' (default) inspects the source; true forces; false skips. */
  bibtex?: boolean | 'auto';
  makeindex?: boolean | 'auto';
  /** Re-run for cross-refs/TOC. 'auto' (default) stops when .aux stabilizes. */
  rerun?: boolean | 'auto' | { maxPasses: number };
  /** Verbosity passed to the engine. */
  verbose?: 'silent' | 'info' | 'debug';
  /** Engines to reuse instead of spawning new ones. */
  handles?: {
    tex?: EngineHandle;
    bibtex?: EngineHandle;
    makeindex?: EngineHandle;
    xdvipdfmx?: EngineHandle;
  };
}

export interface LatexmkResult extends CompileResult {
  /** Number of TeX engine passes actually run. */
  passes: number;
}

const RERUN_PATTERNS = [
  /Rerun to get cross-references right/,
  /Rerun to get citations correct/,
  /Label\(s\) may have changed/,
  /No file [^.]+\.toc/,
  /Package rerunfilecheck Warning/,
];

const DEFAULT_MAX_PASSES = 4;

export async function latexmk(opts: LatexmkOptions): Promise<LatexmkResult> {
  const stripExt = (p: string) => p.replace(/\.tex$/i, '');
  const stem = stripExt(opts.mainTex);
  const auxPath = `${stem}.aux`;
  const idxPath = `${stem}.idx`;
  const xdvPath = `${stem}.xdv`;
  const pdfPath = `${stem}.pdf`;
  const logPath = `${stem}.log`;
  const synctexPath = `${stem}.synctex.gz`;

  const logs: LogEntry[] = [];
  const tex = await buildTexEngine(opts);
  const isXetex = opts.engine === 'xelatex';

  const maxPasses = typeof opts.rerun === 'object' ? opts.rerun.maxPasses : DEFAULT_MAX_PASSES;

  // Detect bibtex/makeindex from sources if 'auto'.
  const needBibtex = resolveAuto(opts.bibtex, () => detectBibtex(opts.files));
  const needMakeindex = resolveAuto(opts.makeindex, () => detectMakeindex(opts.files));

  let lastAux: string | null = null;
  let pass = 0;
  let exitCode = 0;
  let outputs = new Map<string, Uint8Array>();

  while (pass < maxPasses) {
    pass++;
    const result = await tex.compile({
      mainTex: opts.mainTex,
      files: pass === 1 ? opts.files : [],
      // For XeTeX with bibtex, hold the .xdv until the last pass.
      ...(isXetex ? { noPdf: true } : {}),
    });
    logs.push({
      cmd: `${opts.engine} ${opts.mainTex}`,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      log: result.log,
    });
    exitCode = result.exitCode;
    outputs = mergeOutputs(outputs, result.outputs);
    if (exitCode !== 0) break;

    // Bibtex on first pass after we have an .aux.
    if (pass === 1 && needBibtex) {
      const bibtex = await buildBibtex(opts);
      const r = await bibtex.run({ auxFile: auxPath });
      logs.push({
        cmd: `bibtexu ${auxPath}`,
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        log: r.log,
      });
      outputs = mergeOutputs(outputs, r.outputs);
      if (r.exitCode !== 0 && r.exitCode !== 2) break;
    }

    // Makeindex once we have a .idx.
    if (pass === 1 && needMakeindex && outputs.has(idxPath)) {
      const mi = await buildMakeindex(opts);
      const r = await mi.run({ idxFile: idxPath });
      logs.push({
        cmd: `makeindex ${idxPath}`,
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        log: r.log,
      });
      outputs = mergeOutputs(outputs, r.outputs);
    }

    // Stop conditions.
    const aux = bytesToString(outputs.get(auxPath));
    const log = bytesToString(outputs.get(logPath));
    const rerunRequested = RERUN_PATTERNS.some((re) => re.test(log));
    const auxStable = lastAux !== null && aux === lastAux;

    if (opts.rerun === false || opts.rerun === undefined) {
      // No explicit opt-in to multi-pass; one pass only.
      if (pass === 1 && !needBibtex && !needMakeindex) break;
      if (auxStable && !rerunRequested) break;
    } else if (auxStable && !rerunRequested) {
      break;
    }
    lastAux = aux;
  }

  // For xelatex, finalize via xdvipdfmx if we held the .xdv.
  if (isXetex && exitCode === 0 && outputs.has(xdvPath)) {
    const dvi = await buildXdvipdfmx(opts);
    const r = await dvi.run({ xdv: xdvPath, pdf: pdfPath });
    logs.push({
      cmd: `xdvipdfmx -o ${pdfPath} ${xdvPath}`,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      log: r.log,
    });
    outputs = mergeOutputs(outputs, r.outputs);
    if (r.exitCode !== 0) exitCode = r.exitCode;
  }

  const result: LatexmkResult = {
    success: exitCode === 0 && outputs.has(pdfPath),
    log: bytesToString(outputs.get(logPath)),
    logs,
    exitCode,
    passes: pass,
  };
  const pdf = outputs.get(pdfPath);
  if (pdf) result.pdf = pdf;
  const synctex = outputs.get(synctexPath);
  if (synctex) result.synctex = synctex;
  return result;
}

function resolveAuto<T extends boolean | 'auto' | undefined>(
  value: T,
  autoFn: () => boolean,
): boolean {
  if (value === true) return true;
  if (value === false) return false;
  return autoFn();
}

function detectBibtex(files: FileInput[]): boolean {
  return files.some((f) => {
    if (typeof f.content !== 'string') return false;
    return (
      f.content.includes('\\bibliography{') ||
      f.content.includes('\\printbibliography') ||
      f.content.includes('\\addbibresource{')
    );
  });
}

function detectMakeindex(files: FileInput[]): boolean {
  return files.some(
    (f) =>
      typeof f.content === 'string' &&
      (f.content.includes('\\makeindex') || f.content.includes('\\printindex')),
  );
}

function bytesToString(bytes: Uint8Array | undefined): string {
  if (!bytes) return '';
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function mergeOutputs(
  base: Map<string, Uint8Array>,
  add: Map<string, Uint8Array>,
): Map<string, Uint8Array> {
  for (const [k, v] of add) base.set(k, v);
  return base;
}

async function buildTexEngine(opts: LatexmkOptions): Promise<PdfLatex | XeLatex | LuaLatex> {
  if (opts.engine === 'pdflatex')
    return new PdfLatex(opts.handles?.tex ? { engine: opts.handles.tex } : {});
  if (opts.engine === 'xelatex')
    return new XeLatex(opts.handles?.tex ? { engine: opts.handles.tex } : {});
  return new LuaLatex(opts.handles?.tex ? { engine: opts.handles.tex } : {});
}

async function buildBibtex(opts: LatexmkOptions): Promise<Bibtexu> {
  return new Bibtexu(opts.handles?.bibtex ? { engine: opts.handles.bibtex } : {});
}

async function buildMakeindex(opts: LatexmkOptions): Promise<Makeindex> {
  return new Makeindex(opts.handles?.makeindex ? { engine: opts.handles.makeindex } : {});
}

async function buildXdvipdfmx(opts: LatexmkOptions): Promise<Xdvipdfmx> {
  return new Xdvipdfmx(opts.handles?.xdvipdfmx ? { engine: opts.handles.xdvipdfmx } : {});
}
