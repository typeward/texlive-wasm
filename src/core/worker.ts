/**
 * Worker entry point. One Comlink-exposed instance per engine.
 *
 * Loads the engine .wasm + JS glue (Emscripten MODULARIZE=1 EXPORT_ES6=1),
 * sets up WASMFS, drains VFS backends into MEMFS, optionally loads ICU data
 * for ICU-using engines, then exposes `run({ args, files })` that calls
 * pdflatex/xelatex/etc. and returns the outputs.
 *
 * Compile-time mandates we worked around:
 * - Emscripten ENV must be set BEFORE init; we sidestep by using TL's
 *   `-cnf-line=KEY=VAL` args which inject texmf.cnf settings at runtime.
 * - kpathsea search paths derive from $SELFAUTOPARENT (= dirname(thisProgram));
 *   we use thisProgram='/bin/<engine>' so /texmf-dist/web2c is in the cnf path.
 * - ICU's libicudata.a archive members are ELF; we link a stub icudt78_dat
 *   and JS-side load icudt78l.dat via _udata_setCommonData_78 for ICU engines.
 */

import * as Comlink from 'comlink';
import type { EngineConfig, EngineId, RunOptions, RunResult, VfsBackend } from './types';

export interface WorkerInitOptions {
  engineId: EngineId;
  config: EngineConfig;
  backends: VfsBackend[];
  /** Optional: bytes of `icudt78l.dat`. Required for xelatex + bibtexu locale ops. */
  icuData?: Uint8Array;
}

export interface WorkerApi {
  init(opts: WorkerInitOptions): Promise<void>;
  run(opts: RunOptions): Promise<RunResult>;
  dispose(): Promise<void>;
}

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
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _udata_setCommonData_78?: (dataPtr: number, errPtr: number) => void;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}

type ModuleFactory = (
  opts?: Partial<EmscriptenModule> & Record<string, unknown>,
) => Promise<EmscriptenModule>;

/**
 * Per-engine default `-fmt` path. Filled in once the BundleFS has populated
 * MEMFS; consumers can override via RunOptions.env.
 */
const FMT_PATH: Partial<Record<EngineId, string>> = {
  pdflatex: '/texmf-dist/web2c/pdftex/pdflatex.fmt',
  xelatex: '/texmf-dist/web2c/xetex/xelatex.fmt',
  lualatex: '/texmf-dist/web2c/luatex/lualatex.fmt',
};

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

    const glueUrl = this.resolveEngineGlueUrl();
    const factoryModule = (await import(/* @vite-ignore */ glueUrl)) as {
      default: ModuleFactory;
    };

    this.module = await factoryModule.default({
      noInitialRun: true,
      thisProgram: `/bin/${opts.engineId}`,
      print: () => {},
      printErr: () => {},
    });

    const FS = this.module.FS;

    // Load ICU data if provided + the engine supports it.
    if (opts.icuData && this.module._udata_setCommonData_78) {
      const ptr = this.module._malloc(opts.icuData.length);
      this.module.HEAPU8.set(opts.icuData, ptr);
      const errPtr = this.module._malloc(4);
      this.module.HEAPU32[errPtr >> 2] = 0;
      this.module._udata_setCommonData_78(ptr, errPtr);
      const err = this.module.HEAPU32[errPtr >> 2];
      if (err !== 0) {
        // U_ZERO_ERROR is 0; non-zero is informational, ICU still works
        // with fallback paths. We don't fail init.
      }
    }

    mkdirIfMissing(FS, '/bin');
    FS.writeFile(`/bin/${opts.engineId}`, new Uint8Array());
    mkdirIfMissing(FS, '/project');
    mkdirIfMissing(FS, '/tmp');
    mkdirIfMissing(FS, '/texmf-dist');

    // Preload TDS files from every backend that exposes list().
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
  }

  async run(opts: RunOptions): Promise<RunResult> {
    if (!this.engineId || !this.config || !this.module) {
      throw new Error('Worker.init() must be called before run()');
    }
    const FS = this.module.FS;
    const startedAt = performance.now();

    clearDirContents(FS, '/project');
    for (const file of opts.files ?? []) {
      const absolute = `/project/${stripLeadingSlash(file.path)}`;
      mkdirP(FS, dirname(absolute));
      FS.writeFile(absolute, normalizeBytes(file.content));
    }
    FS.chdir(opts.cwd ?? '/project');

    // Capture stdout/stderr.
    let stdout = '';
    let stderr = '';
    this.module.print = (line: string) => {
      stdout += line + '\n';
    };
    this.module.printErr = (line: string) => {
      stderr += line + '\n';
    };

    // Build final argv: prepend our standard -fmt and -cnf-line args.
    const fmt = FMT_PATH[this.engineId];
    const standardArgs: string[] = [];
    if (fmt && FS.analyzePath(fmt).exists) {
      standardArgs.push(`-fmt=${fmt}`);
    }
    standardArgs.push(
      '-cnf-line=TEXMFCNF=/texmf-dist/web2c',
      '-cnf-line=TEXMF=/texmf-dist',
      '-cnf-line=TEXMFDIST=/texmf-dist',
      '-cnf-line=TEXINPUTS=.;/texmf-dist/tex//',
      '-cnf-line=TFMFONTS=/texmf-dist/fonts/tfm//',
      '-cnf-line=VFFONTS=/texmf-dist/fonts/vf//',
      '-cnf-line=T1FONTS=/texmf-dist/fonts/type1//',
      '-cnf-line=ENCFONTS=/texmf-dist/fonts/enc//',
      '-cnf-line=TEXFONTMAPS=/texmf-dist/fonts/map//',
      '-cnf-line=OPENTYPEFONTS=/texmf-dist/fonts/opentype//;/texmf-dist/fonts/truetype//;/texmf-dist/fonts/type1//',
      '-cnf-line=TRUETYPEFONTS=/texmf-dist/fonts/truetype//',
    );
    const argv = [...standardArgs, ...opts.args];

    let exitCode = 0;
    try {
      exitCode = this.module.callMain(argv);
    } catch (err) {
      const e = err as { status?: number };
      if (typeof e?.status === 'number') {
        exitCode = e.status;
      } else {
        throw err;
      }
    }

    const outputs = new Map<string, Uint8Array>();
    collectFiles(FS, '/project', '', outputs);

    return {
      exitCode,
      stdout,
      stderr,
      outputs,
      log: findLog(FS, opts.args),
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
    return new URL(
      `../../engine-artifacts/${this.engineId}/emscripten/${this.engineId}.js`,
      import.meta.url,
    ).toString();
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
