import { BaseEngineWrapper } from './base';
import type { EngineId, FileInput, RunResult } from '../core/types';

export interface BibtexuOptions {
  /** Aux file path (without the .aux extension is fine). */
  auxFile: string;
  files?: FileInput[];
  /** Run in Unicode mode. Default: true. */
  unicode?: boolean;
  extraArgs?: string[];
}

export class Bibtexu extends BaseEngineWrapper {
  protected readonly engineId: EngineId = 'bibtexu';

  async run(options: BibtexuOptions): Promise<RunResult> {
    const args: string[] = [
      ...(options.unicode !== false ? ['-8bit'] : []),
      ...(options.extraArgs ?? []),
      options.auxFile,
    ];
    return this.runRaw(args, options.files ?? []);
  }
}
