import { BaseEngineWrapper } from './base';
import type { EngineId, FileInput, RunResult } from '../core/types';

export interface BibtexuOptions {
  /** Aux file path (without the .aux extension is fine). */
  auxFile: string;
  files?: FileInput[];
  /**
   * Extra raw arguments. Note: bibtexu is Unicode-native (no flag needed);
   * its UTF-8 build compiles the bibtex8-style --8bit switch out entirely.
   * Useful knobs: --min-crossrefs=N, --language, --location.
   */
  extraArgs?: string[];
}

export class Bibtexu extends BaseEngineWrapper {
  protected readonly engineId: EngineId = 'bibtexu';

  async run(options: BibtexuOptions): Promise<RunResult> {
    const args: string[] = [...(options.extraArgs ?? []), options.auxFile];
    return this.runRaw(args, options.files ?? []);
  }
}
