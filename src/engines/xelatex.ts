import { BaseEngineWrapper, limitsOf, type RunLimits } from './base';
import type { EngineId, FileInput, RunResult } from '../core/types';

export interface XeLatexCompileOptions extends RunLimits {
  mainTex: string;
  files?: FileInput[];
  interaction?: 'nonstopmode' | 'batchmode' | 'errorstopmode' | 'scrollmode';
  /**
   * XeTeX writes an `.xdv` intermediate and normally shells out to
   * xdvipdfmx for the PDF — but the WASM build cannot spawn processes
   * (no popen), so that driver mode is unavailable. Default: true (keep
   * the .xdv; run the separate Xdvipdfmx engine on it — `latexmk` does
   * this automatically). Setting false is only useful for native-ish
   * runtimes and will fail in the browser/WASI.
   */
  noPdf?: boolean;
  haltOnError?: boolean;
  extraArgs?: string[];
}

export class XeLatex extends BaseEngineWrapper {
  protected readonly engineId: EngineId = 'xelatex';

  async compile(options: XeLatexCompileOptions): Promise<RunResult> {
    const args: string[] = [
      '--no-shell-escape',
      `--interaction=${options.interaction ?? 'nonstopmode'}`,
      ...(options.haltOnError !== false ? ['--halt-on-error'] : []),
      ...(options.noPdf !== false ? ['--no-pdf'] : []),
      ...(options.extraArgs ?? []),
      options.mainTex,
    ];
    return this.runRaw(args, options.files ?? [], limitsOf(options));
  }
}
