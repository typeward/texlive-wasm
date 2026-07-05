/**
 * latexmk-style driver — multi-pass orchestration.
 *
 * Re-implements the small subset of latexmk's logic we actually need:
 *   1. Run the TeX engine.
 *   2. If `bibtex: 'auto'` and the document contains `\bibliography{…}`,
 *      run bibtexu against the .aux. (biblatex documents default to the
 *      biber backend, which we don't ship — pass `bibtex: true` to force
 *      bibtexu for `backend=bibtex` setups.)
 *   3. If `makeindex: 'auto'` and an .idx was produced (or changed), run
 *      makeindex.
 *   4. Re-run the TeX engine until `.aux` stabilizes (max 4 passes) and no
 *      "Rerun to get cross-references right" message appears in the log.
 *   5. For xelatex, run xdvipdfmx on the resulting .xdv.
 *   6. Collect outputs (.pdf, .synctex.gz, .log).
 *
 * Each engine runs in its own worker with an isolated filesystem that is
 * wiped on every run, so the accumulated project state (sources + generated
 * .aux/.bbl/.idx/.ind/.xdv) is re-materialized into every invocation.
 *
 * Single source of truth for the compile pipeline. Engine wrappers (PdfLatex,
 * XeLatex, LuaLatex) handle individual invocations.
 */

import type { CompileResult, EngineHandle, FileInput, LogEntry, RunResult } from '../core/types';
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
  /**
   * Re-run for cross-refs/TOC. 'auto' (default) stops when .aux stabilizes;
   * false forces a single pass; { maxPasses } caps the loop.
   */
  rerun?: boolean | 'auto' | { maxPasses: number };
  /** Pass -synctex=1 so the engine emits a .synctex.gz. Default: false. */
  synctex?: boolean;
  /** Verbosity forwarded to engines this driver creates. */
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
  // TeX writes all outputs into the cwd under the jobname (= input basename),
  // even when mainTex lives in a subdirectory — key everything by basename.
  const base = stripExt(opts.mainTex).split('/').pop()!;
  const auxPath = `${base}.aux`;
  const idxPath = `${base}.idx`;
  const xdvPath = `${base}.xdv`;
  const pdfPath = `${base}.pdf`;
  const logPath = `${base}.log`;
  const synctexPath = `${base}.synctex.gz`;

  const logs: LogEntry[] = [];
  const isXetex = opts.engine === 'xelatex';

  const rerunMode = opts.rerun ?? 'auto';
  const maxPasses =
    rerunMode === false
      ? 1
      : typeof rerunMode === 'object'
        ? Math.max(1, rerunMode.maxPasses)
        : DEFAULT_MAX_PASSES;

  // Detect bibtex/makeindex from sources if 'auto'.
  const needBibtex = resolveAuto(opts.bibtex, () => detectBibtex(opts.files));
  const needMakeindex = resolveAuto(opts.makeindex, () => detectMakeindex(opts.files));

  const texExtraArgs = opts.synctex ? ['-synctex=1'] : [];

  let lastAux: string | null = null;
  let lastIdx: string | null = null;
  let pass = 0;
  let exitCode = 0;
  let outputs = new Map<string, Uint8Array>();

  // Everything the next engine invocation needs on disk: the caller's
  // sources overlaid with all generated files so far (fresh .aux/.bbl/.ind
  // win over any same-named input).
  const materialize = (): FileInput[] => {
    const merged = new Map<string, FileInput>();
    for (const f of opts.files) merged.set(f.path.replace(/^\/+/, ''), f);
    for (const [path, content] of outputs) merged.set(path, { path, content });
    return [...merged.values()];
  };

  const tex = buildTexEngine(opts);
  // Helper wrappers are created lazily, at most once, and disposed at the
  // end (dispose() is a no-op for wrappers borrowing a caller handle).
  let bibtexWrapper: Bibtexu | null = null;
  let makeindexWrapper: Makeindex | null = null;
  let xdvipdfmxWrapper: Xdvipdfmx | null = null;

  const pushLog = (cmd: string, r: RunResult) => {
    logs.push({ cmd, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, log: r.log });
  };

  try {
    while (pass < maxPasses) {
      pass++;
      const result = await tex.compile({
        mainTex: opts.mainTex,
        files: pass === 1 ? opts.files : materialize(),
        extraArgs: texExtraArgs,
        // XeTeX in WASM cannot spawn xdvipdfmx itself (no popen); we always
        // hold the .xdv and finalize with our own xdvipdfmx pass below.
        ...(isXetex ? { noPdf: true } : {}),
      });
      pushLog(`${opts.engine} ${opts.mainTex}`, result);
      exitCode = result.exitCode;
      outputs = mergeOutputs(outputs, result.outputs);
      if (exitCode !== 0) break;

      let helpersRan = false;

      // Bibtex on the first pass that produced an .aux.
      if (pass === 1 && needBibtex && outputs.has(auxPath)) {
        bibtexWrapper ??= new Bibtexu(wrapperConfig(opts, opts.handles?.bibtex));
        const r = await bibtexWrapper.run({ auxFile: auxPath, files: materialize() });
        pushLog(`bibtexu ${auxPath}`, r);
        outputs = mergeOutputs(outputs, r.outputs);
        // bibtex exit statuses: 0 spotless, 1 warnings, 2 errors, 3 fatal.
        // Warnings are routine (empty fields etc.) and must not abort.
        if (r.exitCode >= 2) {
          exitCode = r.exitCode;
          break;
        }
        helpersRan = true;
      }

      // Makeindex whenever the .idx appeared or changed.
      if (needMakeindex && outputs.has(idxPath)) {
        const idxNow = bytesToString(outputs.get(idxPath));
        if (idxNow !== lastIdx) {
          lastIdx = idxNow;
          makeindexWrapper ??= new Makeindex(wrapperConfig(opts, opts.handles?.makeindex));
          const r = await makeindexWrapper.run({ idxFile: idxPath, files: materialize() });
          pushLog(`makeindex ${idxPath}`, r);
          outputs = mergeOutputs(outputs, r.outputs);
          if (r.exitCode === 0) helpersRan = true;
        }
      }

      if (pass >= maxPasses) break;
      const aux = bytesToString(outputs.get(auxPath));
      const log = bytesToString(outputs.get(logPath));
      const rerunRequested = RERUN_PATTERNS.some((re) => re.test(log));
      const auxStable = lastAux !== null && aux === lastAux;
      lastAux = aux;
      // A fresh .bbl/.ind must be folded in by at least one more pass.
      if (helpersRan) continue;
      if (auxStable && !rerunRequested) break;
    }

    // For xelatex, finalize via xdvipdfmx on the held .xdv.
    if (isXetex && exitCode === 0 && outputs.has(xdvPath)) {
      xdvipdfmxWrapper ??= new Xdvipdfmx(wrapperConfig(opts, opts.handles?.xdvipdfmx));
      const r = await xdvipdfmxWrapper.run({ xdv: xdvPath, pdf: pdfPath, files: materialize() });
      pushLog(`xdvipdfmx -o ${pdfPath} ${xdvPath}`, r);
      outputs = mergeOutputs(outputs, r.outputs);
      if (r.exitCode !== 0) exitCode = r.exitCode;
    }
  } finally {
    // Wrappers created by this call own their workers; release them. A
    // wrapper wrapping a caller-supplied handle no-ops its dispose().
    await Promise.allSettled(
      [tex, bibtexWrapper, makeindexWrapper, xdvipdfmxWrapper]
        .filter((w) => w !== null)
        .map((w) => w.dispose()),
    );
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

function contentToString(content: string | Uint8Array): string {
  if (typeof content === 'string') return content;
  return new TextDecoder('utf-8', { fatal: false }).decode(content);
}

function detectBibtex(files: FileInput[]): boolean {
  // Only classic `\bibliography{…}` — that aux is what bibtexu processes.
  // biblatex markers (\addbibresource, \printbibliography) default to the
  // biber backend which we don't ship, so auto mode leaves them alone.
  return files.some((f) => contentToString(f.content).includes('\\bibliography{'));
}

function detectMakeindex(files: FileInput[]): boolean {
  return files.some((f) => {
    const text = contentToString(f.content);
    return text.includes('\\makeindex') || text.includes('\\printindex');
  });
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

function wrapperConfig(
  opts: LatexmkOptions,
  handle: EngineHandle | undefined,
): { engine?: EngineHandle; verbose?: 'silent' | 'info' | 'debug' } {
  if (handle) return { engine: handle };
  return opts.verbose ? { verbose: opts.verbose } : {};
}

function buildTexEngine(opts: LatexmkOptions): PdfLatex | XeLatex | LuaLatex {
  const config = wrapperConfig(opts, opts.handles?.tex);
  if (opts.engine === 'pdflatex') return new PdfLatex(config);
  if (opts.engine === 'xelatex') return new XeLatex(config);
  return new LuaLatex(config);
}
