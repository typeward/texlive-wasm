/**
 * Worker entry point. One Comlink-exposed instance per engine.
 *
 * The worker caches the engine's ES-module factory, the ICU data bytes and
 * the full TDS file map, and builds a FRESH Emscripten module instance for
 * every run(): TeX engines are not reentrant — a second callMain() on the
 * same instance misbehaves (static C state, getopt position and kpathsea
 * caches survive the first run; observed as wrong exit codes and wasm
 * "index out of bounds" traps). Instance setup costs an instantiation plus
 * repopulating MEMFS from the cached map, which is what correctness costs.
 *
 * Compile-time mandates we worked around:
 * - Emscripten ENV must be set BEFORE init; we sidestep by using TL's
 *   `-cnf-line=KEY=VAL` args which inject texmf.cnf settings at runtime.
 * - kpathsea search paths derive from $SELFAUTOPARENT (= dirname(thisProgram));
 *   we use thisProgram='/bin/<engine>' so /texmf-dist/web2c is in the cnf path.
 * - ICU's libicudata.a archive members are ELF; we link a stub icudt78_dat
 *   and JS-side load icudt78l.dat via _udata_setCommonData_78 for ICU engines.
 * - VFS backends live in the main thread. Comlink can only proxy top-level
 *   arguments, so they arrive as ONE proxied "host" object (dispatch by
 *   index) plus a cloneable capability list (see BackendHost/BackendMeta).
 */

import * as Comlink from 'comlink';
import type { EngineConfig, EngineId, RunOptions, RunResult, VfsBackend } from './types';
import { createBundleFs } from '../vfs/bundlefs';

/** Cloneable capability descriptor for one VFS backend. */
export interface BackendMeta {
  id: string;
  hasList: boolean;
  hasInit: boolean;
  hasDispose: boolean;
}

/**
 * Main-thread dispatcher for the whole backend chain. Passed to init() as a
 * top-level Comlink proxy (nested proxies are not supported by Comlink).
 */
export interface BackendHost {
  read(index: number, tdsPath: string): Promise<Uint8Array | null>;
  exists(index: number, tdsPath: string): Promise<boolean>;
  list(index: number, tdsPrefix: string): Promise<string[]>;
  init(index: number): Promise<void>;
  dispose(index: number): Promise<void>;
}

export interface WorkerInitOptions {
  engineId: EngineId;
  /** Structured-cloneable subset of EngineConfig (no `vfs`). */
  config: EngineConfig;
  /** Capability list, index-aligned with the BackendHost dispatcher. */
  backendMeta?: BackendMeta[];
  /** Optional: bytes of `icudt78l.dat`. Required for xelatex + bibtexu locale ops. */
  icuData?: Uint8Array;
}

export interface WorkerApi {
  init(opts: WorkerInitOptions, host?: BackendHost & Comlink.ProxyMarked): Promise<void>;
  run(opts: RunOptions): Promise<RunResult>;
  dispose(): Promise<void>;
}

/**
 * The WASMFS (-sWASMFS=1) JS API is a *subset* of the legacy FS shim:
 * FS.isDir/isFile don't exist, and FS.analyzePath internally readFile()s any
 * existing path — which throws EISDIR for directories. Only the members
 * below are safe to use; existence/type checks go through stat() (see
 * pathExists / isDirMode).
 */
interface EmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number };
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

/** Engines that speak web2c/kpathsea argv conventions (-fmt, -cnf-line). */
const TEX_ENGINES: ReadonlySet<EngineId> = new Set(['pdflatex', 'xelatex', 'lualatex']);

/**
 * Per-engine default `-fmt` path. Present once the TDS map has been
 * populated into MEMFS; consumers can override via RunOptions.env.
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
  private glueFactory: ModuleFactory | null = null;
  private icuData: Uint8Array | null = null;
  /** TDS-relative path → bytes; repopulated into every fresh instance. */
  private tdsFiles = new Map<string, Uint8Array>();
  // Stable sinks bound at module-factory time. Emscripten's glue captures
  // print/printErr into internal out/err ONCE at instantiation — reassigning
  // module.print afterwards has no effect, so the closures must stay fixed
  // and write through mutable buffers instead.
  private stdoutBuf = '';
  private stderrBuf = '';

  async init(opts: WorkerInitOptions, host?: BackendHost): Promise<void> {
    this.engineId = opts.engineId;
    this.config = opts.config;
    this.backends = (opts.backendMeta ?? []).map((meta, i) =>
      reconstructBackend(meta, i, host ?? null),
    );

    // A bundleUrl is fetched and unpacked here in the worker (highest
    // priority backend) — the browser HTTP cache dedupes the download
    // across engine instances and no file bytes cross the RPC boundary.
    if (opts.config.bundleUrl) {
      this.backends.unshift(await createBundleFs({ bundleUrl: opts.config.bundleUrl }));
    }

    for (const b of this.backends) {
      await b.init?.();
    }

    const glueUrl = this.resolveEngineGlueUrl();
    this.glueFactory = (
      (await import(/* @vite-ignore */ glueUrl)) as { default: ModuleFactory }
    ).default;

    this.icuData = opts.icuData ?? null;
    if (!this.icuData && opts.config.icuDataUrl) {
      const r = await fetch(opts.config.icuDataUrl);
      if (!r.ok) {
        throw new Error(
          `texlive-wasm: HTTP ${r.status} fetching icuDataUrl ${opts.config.icuDataUrl}`,
        );
      }
      this.icuData = new Uint8Array(await r.arrayBuffer());
    }

    // Drain every backend that exposes list() into the in-worker TDS map.
    for (const backend of this.backends) {
      if (!backend.list) continue;
      const paths = await backend.list('');
      for (const tdsPath of paths) {
        const bytes = await backend.read(tdsPath);
        if (bytes) this.tdsFiles.set(stripLeadingSlash(tdsPath), bytes);
      }
    }
  }

  /** Build a fresh engine instance with the TDS + ICU state applied. */
  private async createInstance(): Promise<EmscriptenModule> {
    if (!this.engineId || !this.glueFactory) {
      throw new Error('Worker.init() must be called before run()');
    }
    const module = await this.glueFactory({
      noInitialRun: true,
      thisProgram: `/bin/${this.engineId}`,
      print: (line: string) => {
        this.stdoutBuf += line + '\n';
      },
      printErr: (line: string) => {
        this.stderrBuf += line + '\n';
      },
    });

    if (this.icuData && module._udata_setCommonData_78) {
      const ptr = module._malloc(this.icuData.length);
      module.HEAPU8.set(this.icuData, ptr);
      const errPtr = module._malloc(4);
      module.HEAPU32[errPtr >> 2] = 0;
      module._udata_setCommonData_78(ptr, errPtr);
      // U_ZERO_ERROR is 0; non-zero is informational, ICU still works
      // with fallback paths. We don't fail instance creation.
    }

    const FS = module.FS;
    const dirs = new Set<string>(['/']);
    mkdirCached(FS, '/bin', dirs);
    FS.writeFile(`/bin/${this.engineId}`, new Uint8Array());
    mkdirCached(FS, '/project', dirs);
    if (!pathExists(FS, '/tmp')) FS.mkdir('/tmp');
    dirs.add('/tmp');
    // Writable cache root for luaotfload and friends (see TEXMFVAR/
    // TEXMFCACHE -cnf-line args in run()).
    mkdirCached(FS, '/tmp/texmf-var', dirs);
    mkdirCached(FS, '/texmf-dist', dirs);

    for (const [tdsPath, bytes] of this.tdsFiles) {
      const absolute = `/texmf-dist/${tdsPath}`;
      mkdirCached(FS, dirname(absolute), dirs);
      FS.writeFile(absolute, bytes);
    }
    return module;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    if (!this.engineId || !this.config || !this.glueFactory) {
      throw new Error('Worker.init() must be called before run()');
    }
    const startedAt = performance.now();

    // On-miss lazy fetch: a hard "I can't find file X" fails the compile;
    // we parse those out of the .log, pull the files from the backends into
    // the TDS map, and re-run ONCE — on a fresh instance, like every run.
    const lazyFetch = opts.lazyFetch !== false;
    const maxRetries = lazyFetch ? 1 : 0;
    let exitCode = 0;
    let retriesUsed = 0;
    let stdout = '';
    let stderr = '';
    let outputs = new Map<string, Uint8Array>();
    let log = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const module = await this.createInstance();
      const FS = module.FS;
      for (const file of opts.files ?? []) {
        const absolute = `/project/${stripLeadingSlash(file.path)}`;
        mkdirP(FS, dirname(absolute));
        FS.writeFile(absolute, normalizeBytes(file.content));
      }
      FS.chdir(opts.cwd ?? '/project');

      const argv = [...this.standardArgs(FS, opts), ...opts.args];

      this.stdoutBuf = '';
      this.stderrBuf = '';
      try {
        exitCode = module.callMain(argv);
      } catch (err) {
        const e = err as { status?: number };
        if (typeof e?.status === 'number') {
          exitCode = e.status;
        } else {
          throw err;
        }
      }
      stdout += this.stdoutBuf;
      stderr += this.stderrBuf;

      outputs = new Map<string, Uint8Array>();
      collectFiles(FS, '/project', '', outputs);
      log = findLog(FS, opts.args);

      if (exitCode === 0 || attempt === maxRetries) break;

      const missing = parseMissingFiles(log);
      if (missing.length === 0) break;
      const fetched = await this.fetchMissingIntoTds(missing);
      if (fetched === 0) break;
      retriesUsed++;
    }

    return {
      exitCode,
      stdout,
      stderr,
      outputs,
      log,
      durationMs: performance.now() - startedAt,
      lazyFetchRetries: retriesUsed,
    };
  }

  /** -fmt/-cnf-line are web2c TeX-engine conventions; the other engines reject them. */
  private standardArgs(FS: EmscriptenFS, opts: RunOptions): string[] {
    if (!this.engineId || !TEX_ENGINES.has(this.engineId)) return [];
    const args: string[] = [];
    const fmt = FMT_PATH[this.engineId];
    if (fmt && pathExists(FS, fmt)) {
      args.push(`-fmt=${fmt}`);
    }
    args.push(
      '-cnf-line=TEXMFCNF=/texmf-dist/web2c',
      '-cnf-line=TEXMF=/texmf-dist',
      '-cnf-line=TEXMFDIST=/texmf-dist',
      // Writable cache — luaotfload refuses to start without one. Both vars
      // must point at the SAME root: with openout_any=p (paranoid, the TL
      // default) LuaTeX only permits absolute-path writes under $TEXMFVAR /
      // $TEXMFSYSVAR, and luaotfload prefers $TEXMFCACHE — pointing it
      // anywhere else gets every cache mkdir/write "operation not
      // permitted" (verified against the real engine).
      '-cnf-line=TEXMFVAR=/tmp/texmf-var',
      '-cnf-line=TEXMFCACHE=/tmp/texmf-var',
      '-cnf-line=TEXINPUTS=.;/texmf-dist/tex//',
      '-cnf-line=TFMFONTS=/texmf-dist/fonts/tfm//',
      '-cnf-line=VFFONTS=/texmf-dist/fonts/vf//',
      '-cnf-line=T1FONTS=/texmf-dist/fonts/type1//',
      '-cnf-line=ENCFONTS=/texmf-dist/fonts/enc//',
      '-cnf-line=TEXFONTMAPS=/texmf-dist/fonts/map//',
      '-cnf-line=OPENTYPEFONTS=/texmf-dist/fonts/opentype//;/texmf-dist/fonts/truetype//;/texmf-dist/fonts/type1//',
      '-cnf-line=TRUETYPEFONTS=/texmf-dist/fonts/truetype//',
    );
    // RunOptions.env entries become texmf.cnf overrides — the only runtime
    // environment channel Emscripten leaves us (ENV is frozen after init).
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      args.push(`-cnf-line=${key}=${value}`);
    }
    return args;
  }

  /**
   * For each missing TDS path the log complained about, walk the backend
   * chain and store the bytes into the TDS map (the next instance picks
   * them up). Returns how many files were resolved. Searches multiple
   * plausible TDS sublocations because the log usually says
   * "lmroman10-regular.otf", not the absolute TDS path.
   */
  private async fetchMissingIntoTds(missing: string[]): Promise<number> {
    let written = 0;
    for (const name of missing) {
      const candidates = expandMissingName(name);
      for (const candidate of candidates) {
        let bytes: Uint8Array | null = null;
        for (const backend of this.backends) {
          try {
            const r = await backend.read(candidate);
            if (r) {
              bytes = r;
              break;
            }
          } catch {
            // A flaky backend (offline CDN, 5xx) must not abort the whole
            // retry — fall through to the next backend.
          }
        }
        if (bytes) {
          this.tdsFiles.set(stripLeadingSlash(candidate), bytes);
          written++;
          break;
        }
      }
    }
    return written;
  }

  async dispose(): Promise<void> {
    for (const b of this.backends) {
      await b.dispose?.();
    }
    this.glueFactory = null;
    this.tdsFiles.clear();
  }

  private resolveEngineGlueUrl(): string {
    if (!this.config || !this.engineId) {
      throw new Error('resolveEngineGlueUrl: config missing');
    }
    if (this.config.enginePath) {
      return this.config.enginePath.replace(/\.wasm$/, '.js');
    }
    // No artifact ships inside the npm package (the .wasm files live on
    // GitHub Releases), so there is no meaningful default URL to guess —
    // and a bundler-mangled relative URL would 404 confusingly anyway.
    throw new Error(
      `texlive-wasm: config.enginePath is required. Download the engine artifacts ` +
        `('npx texlive-wasm download-assets') and pass e.g. ` +
        `enginePath: '/texlive-wasm/${this.engineId}/emscripten/${this.engineId}.wasm'.`,
    );
  }
}

// ----- helpers --------------------------------------------------------------

function reconstructBackend(
  meta: BackendMeta,
  index: number,
  host: BackendHost | null,
): VfsBackend {
  if (!host) {
    throw new Error('Worker.init(): backendMeta supplied without a BackendHost proxy');
  }
  const backend: VfsBackend = {
    id: meta.id,
    read: (tdsPath: string) => host.read(index, tdsPath),
    exists: (tdsPath: string) => host.exists(index, tdsPath),
  };
  if (meta.hasList) backend.list = (tdsPrefix: string) => host.list(index, tdsPrefix);
  if (meta.hasInit) backend.init = () => host.init(index);
  if (meta.hasDispose) backend.dispose = () => host.dispose(index);
  return backend;
}

function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, '');
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** Existence check that is safe for directories under WASMFS (see interface note). */
function pathExists(FS: EmscriptenFS, path: string): boolean {
  try {
    FS.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** S_IFDIR test on a stat mode — the WASMFS shim has no FS.isDir. */
function isDirMode(mode: number): boolean {
  return (mode & 0xf000) === 0x4000;
}

function mkdirP(FS: EmscriptenFS, path: string): void {
  if (!path || path === '/' || pathExists(FS, path)) return;
  mkdirP(FS, dirname(path));
  FS.mkdir(path);
}

/**
 * mkdir -p with a caller-held cache of created dirs — populating tens of
 * thousands of TDS files per instance makes per-file stat() checks add up.
 */
function mkdirCached(FS: EmscriptenFS, path: string, seen: Set<string>): void {
  if (!path || seen.has(path)) return;
  const parent = dirname(path);
  if (parent !== path) mkdirCached(FS, parent, seen);
  if (!pathExists(FS, path)) FS.mkdir(path);
  seen.add(path);
}

function normalizeBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
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
    if (isDirMode(st.mode)) {
      collectFiles(FS, abs, rel, out);
    } else {
      out.set(rel, FS.readFile(abs));
    }
  }
}

/**
 * Pull "I can't find file `x.sty'" / "Font ... not found" / "! LaTeX
 * Error: File `x.sty' not found" lines out of the .log and return the
 * referenced filenames.
 */
function parseMissingFiles(log: string): string[] {
  if (!log) return [];
  const out = new Set<string>();
  const patterns = [
    /I can't find file `([^']+)'/g,
    /File `([^']+)' not found/g,
    /file `([^']+)' is not loadable/g,
    /Cannot find ([\w.-]+\.(?:sty|cls|fd|def|cfg|tfm|vf|pfb|otf|ttf|mf|enc|map))/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(log)) !== null) {
      const name = m[1]?.trim();
      if (name && !name.includes('//') && !name.startsWith('-')) out.add(name);
    }
  }
  return Array.from(out);
}

/**
 * Given a bare file name like "amsmath.sty", produce the candidate TDS
 * subpaths a backend might serve it under. The backend's read() will be
 * tried for each in order.
 */
function expandMissingName(name: string): string[] {
  if (name.startsWith('/')) return [name];
  if (name.includes('/')) return [name];
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const stem = name;
  const out = [stem];
  if (ext === 'sty' || ext === 'cls' || ext === 'def' || ext === 'fd' || ext === 'cfg') {
    out.push(`tex/latex/${stem.replace(/\.\w+$/, '')}/${stem}`);
    out.push(`tex/latex/base/${stem}`);
  } else if (ext === 'tex' || ext === 'ltx') {
    out.push(`tex/generic/${stem.replace(/\.\w+$/, '')}/${stem}`);
  } else if (ext === 'tfm') {
    out.push(`fonts/tfm/public/${stem.replace(/\.\w+$/, '')}/${stem}`);
  } else if (ext === 'otf' || ext === 'ttf') {
    out.push(`fonts/opentype/public/${stem.replace(/\d.*$/, '')}/${stem}`);
    out.push(`fonts/truetype/public/${stem.replace(/\d.*$/, '')}/${stem}`);
  } else if (ext === 'pfb' || ext === 'pfa') {
    out.push(`fonts/type1/public/${stem.replace(/\d.*$/, '')}/${stem}`);
  } else if (ext === 'map' || ext === 'enc') {
    out.push(`fonts/${ext}/dvips/${stem.replace(/\.\w+$/, '')}/${stem}`);
  }
  return out;
}

/**
 * Locate the TeX .log for this run. Honors -jobname; otherwise derives the
 * jobname from the first .tex/.ltx argument (basename — TeX writes the log
 * into the cwd regardless of the input file's directory).
 */
function findLog(FS: EmscriptenFS, args: string[]): string {
  let stem: string | undefined;
  const jobArg = args.find((a) => /^--?jobname=/.test(a));
  if (jobArg) {
    stem = jobArg.split('=')[1];
  } else {
    const texArg = args.find((a) => /\.(tex|ltx)$/i.test(a));
    stem = texArg
      ?.replace(/\.(tex|ltx)$/i, '')
      .split('/')
      .pop();
  }
  if (!stem) return '';
  const logPath = `/project/${stem}.log`;
  if (!pathExists(FS, logPath)) return '';
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(FS.readFile(logPath));
  } catch {
    return '';
  }
}

const api = new WorkerImpl();
Comlink.expose(api);
