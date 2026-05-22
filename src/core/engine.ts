/**
 * createEngine — public entry point for the low-level API.
 *
 * Spins up a Web Worker per engine instance and proxies all calls via Comlink.
 * The worker loads the engine .wasm, sets up WASMFS with the configured VFS
 * backend chain, and exposes a typed RPC surface.
 */

import * as Comlink from 'comlink';
import type {
  EngineConfig,
  EngineHandle,
  EngineId,
  RunOptions,
  RunResult,
  VfsBackend,
} from './types';
import { defaultBackends } from '../vfs';
import type { WorkerApi } from './worker';

const DEFAULT_CONFIG: Required<Pick<EngineConfig, 'useWorker' | 'verbose'>> = {
  useWorker: typeof Worker !== 'undefined',
  verbose: 'silent',
};

export async function createEngine(id: EngineId, config: EngineConfig = {}): Promise<EngineHandle> {
  const merged: EngineConfig = { ...DEFAULT_CONFIG, ...config };
  const backends: VfsBackend[] = merged.vfs ?? (await defaultBackends(id, merged));

  if (merged.useWorker) {
    return createWorkerEngine(id, merged, backends);
  }
  return createInProcessEngine(id, merged, backends);
}

async function createWorkerEngine(
  id: EngineId,
  config: EngineConfig,
  backends: VfsBackend[],
): Promise<EngineHandle> {
  // Vite requires Worker options to be statically analyzable; keep the object literal inline.
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'texlive-wasm-worker',
  });
  const api = Comlink.wrap<WorkerApi>(worker);
  // Backends that live in the main thread (e.g. TauriFS) get proxied back
  // through Comlink so the worker can call them. BundleFS, which is pure
  // data, gets transferred as bytes.
  const proxiedBackends = backends.map((b) => Comlink.proxy(b));
  await api.init({
    engineId: id,
    config: structuredClone(config),
    backends: proxiedBackends,
  });

  let ready = true;
  return {
    id,
    config,
    async run(options: RunOptions): Promise<RunResult> {
      if (!ready) throw new Error(`Engine ${id} has been disposed`);
      return api.run(options);
    },
    async dispose(): Promise<void> {
      ready = false;
      try {
        await api.dispose();
      } finally {
        worker.terminate();
      }
    },
    isReady(): boolean {
      return ready;
    },
  };
}

async function createInProcessEngine(
  _id: EngineId,
  _config: EngineConfig,
  _backends: VfsBackend[],
): Promise<EngineHandle> {
  // TODO(phase 1): direct in-process implementation for Node/WASI.
  // The worker path is the primary one; this is a thin shim that imports the
  // same engine-loading code without spawning a worker. Useful for tests and
  // for the wasi-sdk Node target.
  throw new Error('In-process engine not yet implemented; pass useWorker: true for now.');
}
