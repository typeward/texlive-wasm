import { BaseEngineWrapper } from './base';
import type { EngineId, FileInput, RunResult } from '../core/types';

export interface PdfLatexCompileOptions {
  /** Main .tex file path (relative to /project). */
  mainTex: string;
  /** Files to drop into /project before the engine runs. */
  files?: FileInput[];
  /** --interaction= value. Default: 'nonstopmode'. */
  interaction?: 'nonstopmode' | 'batchmode' | 'errorstopmode' | 'scrollmode';
  /** Output format. Default: 'pdf'. */
  outputFormat?: 'pdf' | 'dvi';
  /** Halt the engine on the first error. Default: true. */
  haltOnError?: boolean;
  /** Pass extra raw arguments verbatim. */
  extraArgs?: string[];
}

export class PdfLatex extends BaseEngineWrapper {
  protected readonly engineId: EngineId = 'pdflatex';

  async compile(options: PdfLatexCompileOptions): Promise<RunResult> {
    const args: string[] = [
      '--no-shell-escape',
      `--interaction=${options.interaction ?? 'nonstopmode'}`,
      ...(options.haltOnError !== false ? ['--halt-on-error'] : []),
      `--output-format=${options.outputFormat ?? 'pdf'}`,
      ...(options.extraArgs ?? []),
      options.mainTex,
    ];
    return this.runRaw(args, options.files ?? []);
  }
}
