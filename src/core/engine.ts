/**
 * createEngine — public entry point for the low-level API.
 *
 * Spins up a Web Worker per engine instance and proxies all calls via Comlink.
 * The worker loads the engine .wasm, sets up the FS with the configured VFS
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
import type { BackendHost, BackendMeta, WorkerApi } from './worker';

const DEFAULT_CONFIG: Required<Pick<EngineConfig, 'useWorker' | 'verbose'>> = {
  useWorker: typeof Worker !== 'undefined',
  verbose: 'silent',
};

/** How long dispose() waits for the worker to acknowledge before terminating it. */
const DISPOSE_GRACE_MS = 2000;

export async function createEngine(id: EngineId, config: EngineConfig = {}): Promise<EngineHandle> {
  const merged: EngineConfig = { ...DEFAULT_CONFIG, ...config };
  // With a worker, the manifest's core bundle is unpacked inside it (see
  // WorkerInitOptions.bundleFromManifest) — building it out here would keep a
  // second copy of the whole TeX tree on the main thread and then trickle it
  // across the RPC boundary file by file.
  const bundleInWorker = merged.useWorker === true && !merged.vfs && !!merged.manifestUrl;
  const backends: VfsBackend[] =
    merged.vfs ?? (await defaultBackends(id, merged, { skipManifestBundle: bundleInWorker }));

  if (merged.useWorker) {
    return createWorkerEngine(id, merged, backends, bundleInWorker);
  }
  return createInProcessEngine(id, merged, backends);
}

/**
 * Comlink only converts a value into a live proxy when it is a *top-level*
 * argument or return value — proxy markers nested inside a plain object are
 * structured-cloned instead (and objects with function properties throw
 * DataCloneError). So the backend chain crosses the worker boundary as ONE
 * top-level proxied "host" object that dispatches by index, plus a cloneable
 * capability list so the worker knows which optional methods exist.
 */
function makeBackendHost(backends: VfsBackend[]): BackendHost {
  return {
    async read(i: number, tdsPath: string): Promise<Uint8Array | null> {
      return (await backends[i]!.read(tdsPath)) ?? null;
    },
    async exists(i: number, tdsPath: string): Promise<boolean> {
      const b = backends[i]!;
      if (b.exists) return b.exists(tdsPath);
      return (await b.read(tdsPath)) != null;
    },
    async list(i: number, tdsPrefix: string): Promise<string[]> {
      const b = backends[i]!;
      return b.list ? await b.list(tdsPrefix) : [];
    },
    async init(i: number): Promise<void> {
      await backends[i]!.init?.();
    },
    async dispose(i: number): Promise<void> {
      await backends[i]!.dispose?.();
    },
  };
}

async function createWorkerEngine(
  id: EngineId,
  config: EngineConfig,
  backends: VfsBackend[],
  bundleFromManifest = false,
): Promise<EngineHandle> {
  // Vite requires Worker options to be statically analyzable; keep the object literal inline.
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'texlive-wasm-worker',
  });
  // Comlink never rejects on worker load failure — surface it ourselves so
  // createEngine() rejects instead of hanging forever.
  const workerFailed = new Promise<never>((_, reject) => {
    worker.addEventListener('error', (event) => {
      const msg = (event as ErrorEvent).message || 'worker failed to load';
      reject(new Error(`texlive-wasm: engine worker error: ${msg}`));
    });
  });
  const api = Comlink.wrap<WorkerApi>(worker);

  // config.vfs holds objects with methods — not structured-cloneable. The
  // worker never needs it (it gets the host proxy instead), so strip it.
  const { vfs: _vfs, ...cloneableConfig } = config;
  const backendMeta: BackendMeta[] = backends.map((b) => ({
    id: b.id,
    hasList: typeof b.list === 'function',
    hasInit: typeof b.init === 'function',
    hasDispose: typeof b.dispose === 'function',
  }));

  try {
    await Promise.race([
      api.init(
        {
          engineId: id,
          config: cloneableConfig,
          backendMeta,
          ...(bundleFromManifest ? { bundleFromManifest: true } : {}),
        },
        Comlink.proxy(makeBackendHost(backends)),
      ),
      workerFailed,
    ]);
  } catch (err) {
    worker.terminate();
    throw err;
  }

  let ready = true;
  // Serialize run() calls: the worker executes callMain synchronously and
  // interleaved lazy-fetch awaits from two concurrent runs would corrupt
  // each other's /project state.
  let queue: Promise<unknown> = Promise.resolve();

  // Killing the worker leaves the in-flight Comlink call unsettled forever —
  // its reply can never arrive. Every path that terminates the worker settles
  // this instead, so a caller awaiting run() gets an error rather than a hang.
  let killRun: (err: Error) => void = () => {};
  const killed = new Promise<never>((_, reject) => {
    killRun = reject;
  });
  killed.catch(() => {}); // nobody races it while the worker is healthy

  const terminate = (reason: string): void => {
    ready = false;
    worker.terminate();
    killRun(new Error(`Engine ${id}: ${reason}`));
  };

  const doRun = async (options: RunOptions): Promise<RunResult> => {
    if (!ready) throw new Error(`Engine ${id} has been disposed`);
    // An AbortSignal is not structured-cloneable — it stays on this side.
    const { signal, ...runOptions } = options;
    if (signal?.aborted) throw new Error(`Engine ${id}: run aborted before it started`);

    let timer: ReturnType<typeof setTimeout> | undefined;
    // callMain is synchronous inside the worker, so neither a timeout nor an
    // abort can interrupt it — the only way to stop the engine is to kill the
    // worker, which makes the handle unusable afterwards.
    const onAbort = () => terminate('run aborted; worker terminated');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(
        () => terminate(`run exceeded timeoutMs=${options.timeoutMs}; worker terminated`),
        options.timeoutMs,
      );
    }
    try {
      return await Promise.race([api.run(runOptions), killed]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };

  return {
    id,
    config,
    async run(options: RunOptions): Promise<RunResult> {
      const result = queue.then(() => doRun(options));
      queue = result.catch(() => {});
      return result;
    },
    async dispose(): Promise<void> {
      if (!ready) return;
      ready = false;
      try {
        // A worker stuck in synchronous callMain never answers — don't let
        // dispose() hang on it.
        await Promise.race([
          api.dispose(),
          new Promise((resolve) => setTimeout(resolve, DISPOSE_GRACE_MS)),
        ]);
      } finally {
        worker.terminate();
        killRun(new Error(`Engine ${id} was disposed while a run was in flight`));
      }
    },
    isReady(): boolean {
      return ready;
    },
  };
}

async function createInProcessEngine(
  id: EngineId,
  _config: EngineConfig,
  _backends: VfsBackend[],
): Promise<EngineHandle> {
  // TODO(phase 3): direct in-process implementation for Node/WASI. The worker
  // path is the primary one; this would be a thin shim that imports the same
  // engine-loading code without spawning a worker.
  //
  // Node has no global Worker either, so "pass useWorker: true" is not a
  // workaround — there is no way to run an engine under plain Node today.
  throw new Error(
    `texlive-wasm: running ${id} outside a Web Worker (Node / WASI) is not implemented yet. ` +
      `The engines currently require a browser, Tauri WebView, or another Worker-capable host.`,
  );
}
