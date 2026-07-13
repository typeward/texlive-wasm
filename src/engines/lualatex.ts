import { BaseEngineWrapper, limitsOf, type RunLimits } from './base';
import type { EngineId, FileInput, RunResult } from '../core/types';

export interface LuaLatexCompileOptions extends RunLimits {
  mainTex: string;
  files?: FileInput[];
  interaction?: 'nonstopmode' | 'batchmode' | 'errorstopmode' | 'scrollmode';
  haltOnError?: boolean;
  /** Disable luasocket. We default to true since the WASM build has no real network. */
  noSocket?: boolean;
  extraArgs?: string[];
}

export class LuaLatex extends BaseEngineWrapper {
  protected readonly engineId: EngineId = 'lualatex';

  async compile(options: LuaLatexCompileOptions): Promise<RunResult> {
    const args: string[] = [
      '--no-shell-escape',
      `--interaction=${options.interaction ?? 'nonstopmode'}`,
      ...(options.haltOnError !== false ? ['--halt-on-error'] : []),
      ...(options.noSocket !== false ? ['--nosocket'] : []),
      ...(options.extraArgs ?? []),
      options.mainTex,
    ];
    return this.runRaw(args, options.files ?? [], limitsOf(options));
  }
}
