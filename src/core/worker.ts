/**
 * Worker entry point. One Comlink-exposed instance per engine.
 *
 * Responsibilities:
 *   1. Load the engine .wasm + JS glue (an Emscripten `MODULARIZE=1 -sEXPORT_ES6=1`
 *      factory). The factory is dynamically imported by URL because the path
 *      depends on the engine id and the consumer's bundling setup.
 *   2. Mount the WASMFS tree:
 *         /project     MEMFS  (user-supplied files for the current run)
 *         /tmp         MEMFS  (engine scratch: aux, log, synctex, font cache)
 *         /texmf-dist  MEMFS  populated from the VFS backend chain at init.
 *      Phase 1 strategy: preload (eagerly walk every backend that exposes
 *      `list()` and copy its bytes into MEMFS). This is simple, predictable,
 *      and matches what busytex did — its limitation (large startup memory
 *      cost) is offset by our smaller core bundle. Phase 2 swaps the
 *      texmf-dist mount for a JSFILEFS-backed async layer.
 *   3. Expose run({ args, files, cwd, env }) — write opts.files into /project,
 *      callMain(args), capture stdout/stderr/outputs/log.
 */

import * as Comlink from 'comlink';
import type { EngineConfig, EngineId, RunOptions, RunResult, VfsBackend } from './types';

export interface WorkerInitOptions {
  engineId: EngineId;
  config: EngineConfig;
  backends: VfsBackend[];
}

export interface WorkerApi {
  init(opts: WorkerInitOptions): Promise<void>;
  run(opts: RunOptions): Promise<RunResult>;
  dispose(): Promise<void>;
}

/** Minimal shape of the Emscripten Module we use. Not exhaustive. */
interface EmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number };
  isFile(mode: number): boolean;
  isDir(mode: number): boolean;
  analyzePath(path: string): { exists: boolean };
  chdir(path: string): void;
  unlink(path: string): void;
}

interface EmscriptenModule {
  FS: EmscriptenFS;
  ENV: Record<string, string>;
  callMain(args: string[]): number;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  HEAPU8: Uint8Array;
}

type ModuleFactory = (opts?: Partial<EmscriptenModule>) => Promise<EmscriptenModule>;

class WorkerImpl implements WorkerApi {
  private engineId: EngineId | null = null;
  private config: EngineConfig | null = null;
  private backends: VfsBackend[] = [];
  private module: EmscriptenModule | null = null;

  async init(opts: WorkerInitOptions): Promise<void> {
    this.engineId = opts.engineId;
    this.config = opts.config;
    this.backends = opts.backends;

    for (const b of this.backends) {
      await b.init?.();
    }

    // The engine's .js glue is an ES module that default-exports a factory.
    // We resolve it relative to enginePath (or the manifest dir, or a default
    // location alongside the npm package).
    const glueUrl = this.resolveEngineGlueUrl();
    const factoryModule = (await import(/* @vite-ignore */ glueUrl)) as {
      default: ModuleFactory;
    };

    this.module = await factoryModule.default({
      print: (text: string) => {
        // captured per-run via the listeners we attach in run()
        void text;
      },
      printErr: (text: string) => {
        void text;
      },
    });

    const FS = this.module.FS;
    mkdirIfMissing(FS, '/project');
    mkdirIfMissing(FS, '/tmp');
    mkdirIfMissing(FS, '/texmf-dist');

    // Preload TDS files from every backend that knows how to enumerate.
    // Backends that only support point lookups (FETCHFS) are silently skipped
    // here — they'll be consulted lazily once we wire JSFILEFS in Phase 2.
    for (const backend of this.backends) {
      if (!backend.list) continue;
      const paths = await backend.list('');
      for (const tdsPath of paths) {
        const bytes = await backend.read(tdsPath);
        if (!bytes) continue;
        const absolute = `/texmf-dist/${stripLeadingSlash(tdsPath)}`;
        mkdirP(FS, dirname(absolute));
        FS.writeFile(absolute, bytes);
      }
    }

    // Standard TL env vars so kpathsea finds everything.
    Object.assign(this.module.ENV, {
      TEXMFDIST: '/texmf-dist',
      TEXMFCNF: '/texmf-dist/web2c',
      TEXMFVAR: '/tmp/texmf-var',
      TEXMFCACHE: '/tmp/texmf-cache',
      HOME: '/tmp',
      ...(opts.config.verbose === 'debug' ? { KPATHSEA_DEBUG: '32' } : {}),
    });
  }

  async run(opts: RunOptions): Promise<RunResult> {
    if (!this.engineId || !this.config) {
      throw new Error('Worker.init() must be called before run()');
    }
    if (!this.module) {
      throw new Error('Worker module not loaded (init() failed?)');
    }
    const FS = this.module.FS;
    const startedAt = performance.now();

    // Stage user files into /project, then chdir there.
    clearDirContents(FS, '/project');
    for (const file of opts.files ?? []) {
      const absolute = `/project/${stripLeadingSlash(file.path)}`;
      mkdirP(FS, dirname(absolute));
      FS.writeFile(absolute, normalizeBytes(file.content));
    }
    FS.chdir(opts.cwd ?? '/project');

    // Apply per-run env vars.
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        this.module.ENV[k] = v;
      }
    }

    // Capture stdout/stderr for THIS call.
    let stdout = '';
    let stderr = '';
    this.module.print = (line: string) => {
      stdout += line + '\n';
    };
    this.module.printErr = (line: string) => {
      stderr += line + '\n';
    };

    // Run the engine. Emscripten's callMain takes argv after the program name.
    let exitCode = 0;
    try {
      exitCode = this.module.callMain(opts.args);
    } catch (err) {
      // Emscripten throws an ExitStatus-like object on exit; treat that as a
      // clean exit and surface its status. For real exceptions, re-throw.
      const e = err as { status?: number; name?: string };
      if (typeof e?.status === 'number') {
        exitCode = e.status;
      } else {
        throw err;
      }
    }

    // Collect /project outputs.
    const outputs = new Map<string, Uint8Array>();
    collectFiles(FS, '/project', '', outputs);

    // Extract the .log if the user passed a .tex on the command line.
    const log = findLog(FS, opts.args);

    return {
      exitCode,
      stdout,
      stderr,
      outputs,
      log,
      durationMs: performance.now() - startedAt,
    };
  }

  async dispose(): Promise<void> {
    for (const b of this.backends) {
      await b.dispose?.();
    }
    this.module = null;
  }

  private resolveEngineGlueUrl(): string {
    if (!this.config || !this.engineId) {
      throw new Error('resolveEngineGlueUrl: config missing');
    }
    if (this.config.enginePath) {
      return this.config.enginePath.replace(/\.wasm$/, '.js');
    }
    // Default: assume the artifact ships alongside the wrapper bundle.
    return new URL(`../../engine-artifacts/${this.engineId}.js`, import.meta.url).toString();
  }
}

// ----- helpers --------------------------------------------------------------

function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, '');
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function mkdirIfMissing(FS: EmscriptenFS, path: string): void {
  if (FS.analyzePath(path).exists) return;
  FS.mkdir(path);
}

function mkdirP(FS: EmscriptenFS, path: string): void {
  if (!path || path === '/' || FS.analyzePath(path).exists) return;
  mkdirP(FS, dirname(path));
  FS.mkdir(path);
}

function normalizeBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

function clearDirContents(FS: EmscriptenFS, dir: string): void {
  if (!FS.analyzePath(dir).exists) {
    mkdirP(FS, dir);
    return;
  }
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const full = `${dir}/${name}`;
    const st = FS.stat(full);
    if (FS.isDir(st.mode)) {
      clearDirContents(FS, full);
    } else {
      FS.unlink(full);
    }
  }
}

function collectFiles(
  FS: EmscriptenFS,
  absDir: string,
  relPrefix: string,
  out: Map<string, Uint8Array>,
): void {
  for (const name of FS.readdir(absDir)) {
    if (name === '.' || name === '..') continue;
    const abs = `${absDir}/${name}`;
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    const st = FS.stat(abs);
    if (FS.isDir(st.mode)) {
      collectFiles(FS, abs, rel, out);
    } else {
      out.set(rel, FS.readFile(abs));
    }
  }
}

function findLog(FS: EmscriptenFS, args: string[]): string {
  const texArg = args.find((a) => a.endsWith('.tex'));
  if (!texArg) return '';
  const stem = texArg.replace(/\.tex$/, '');
  const logPath = `/project/${stem}.log`;
  if (!FS.analyzePath(logPath).exists) return '';
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(FS.readFile(logPath));
  } catch {
    return '';
  }
}

const api = new WorkerImpl();
Comlink.expose(api);
