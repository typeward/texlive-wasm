import { BaseEngineWrapper } from './base';
import type { EngineId, FileInput, RunResult } from '../core/types';

export interface XeLatexCompileOptions {
  mainTex: string;
  files?: FileInput[];
  interaction?: 'nonstopmode' | 'batchmode' | 'errorstopmode' | 'scrollmode';
  /**
   * XeTeX always writes an `.xdv` intermediate; pass `noPdf: true` if you want
   * to keep it as `.xdv` (typically because you'll run bibtex/biber and then
   * xdvipdfmx yourself). Default: false (engine produces the .xdv but the
   * xelatex driver also writes .pdf via xdvipdfmx).
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
      ...(options.noPdf ? ['--no-pdf'] : []),
      ...(options.extraArgs ?? []),
      options.mainTex,
    ];
    return this.runRaw(args, options.files ?? []);
  }
}
