import { BaseEngineWrapper } from './base';
import type { EngineId, FileInput, RunResult } from '../core/types';

export interface MakeindexOptions {
  /** .idx file path. */
  idxFile: string;
  files?: FileInput[];
  /** -s style file. */
  style?: string;
  /** -o output file. */
  output?: string;
  extraArgs?: string[];
}

export class Makeindex extends BaseEngineWrapper {
  protected readonly engineId: EngineId = 'makeindex';

  async run(options: MakeindexOptions): Promise<RunResult> {
    const args: string[] = [
      ...(options.style ? ['-s', options.style] : []),
      ...(options.output ? ['-o', options.output] : []),
      ...(options.extraArgs ?? []),
      options.idxFile,
    ];
    return this.runRaw(args, options.files ?? []);
  }
}
