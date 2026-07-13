import { BaseEngineWrapper, limitsOf, type RunLimits } from './base';
import type { EngineId, FileInput, RunResult } from '../core/types';

export interface XdvipdfmxOptions extends RunLimits {
  /** Input .xdv path. */
  xdv: string;
  /** Output .pdf path. */
  pdf: string;
  files?: FileInput[];
  extraArgs?: string[];
}

export class Xdvipdfmx extends BaseEngineWrapper {
  protected readonly engineId: EngineId = 'xdvipdfmx';

  async run(options: XdvipdfmxOptions): Promise<RunResult> {
    const args: string[] = ['-o', options.pdf, ...(options.extraArgs ?? []), options.xdv];
    return this.runRaw(args, options.files ?? [], limitsOf(options));
  }
}
