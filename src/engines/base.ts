/**
 * Shared base for the typed engine wrappers.
 *
 * The wrapper classes are intentionally thin — they format argv, set sensible
 * defaults, and forward to engine.run(). Multi-pass orchestration lives in
 * `latexmk`, not here.
 */

import { createEngine } from '../core/engine';
import type {
  EngineConfig,
  EngineHandle,
  EngineId,
  FileInput,
  RunOptions,
  RunResult,
} from '../core/types';

export interface EngineWrapperOptions extends Omit<EngineConfig, 'useWorker'> {
  /** Reuse an existing handle instead of creating a new one. */
  engine?: EngineHandle;
  /** Pass to the underlying createEngine() if no handle is supplied. */
  useWorker?: boolean;
}

export abstract class BaseEngineWrapper {
  protected abstract readonly engineId: EngineId;
  protected handle: EngineHandle | null = null;

  constructor(protected options: EngineWrapperOptions = {}) {
    if (options.engine) this.handle = options.engine;
  }

  protected async ensureHandle(): Promise<EngineHandle> {
    if (this.handle) return this.handle;
    const { engine: _ignored, ...config } = this.options;
    void _ignored;
    this.handle = await createEngine(this.engineId, config);
    return this.handle;
  }

  /** Drop the worker if this wrapper owns one. */
  async dispose(): Promise<void> {
    // Only dispose if we created the handle ourselves.
    if (this.handle && !this.options.engine) {
      await this.handle.dispose();
      this.handle = null;
    }
  }

  protected async runRaw(
    args: string[],
    files: FileInput[],
    extra: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<RunResult> {
    const handle = await this.ensureHandle();
    const opts: RunOptions = {
      args,
      files,
      cwd: extra.cwd ?? '/project',
    };
    if (extra.timeoutMs !== undefined) opts.timeoutMs = extra.timeoutMs;
    if (extra.env !== undefined) opts.env = extra.env;
    return handle.run(opts);
  }
}
