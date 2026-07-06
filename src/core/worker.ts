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
import { loadManifest } from './manifest';
import { buildLsR } from './lsr';

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

/** Minimal fontconfig config for XeTeX (see createInstance). */
const FONTS_CONF = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/texmf-dist/fonts/opentype</dir>
  <dir>/texmf-dist/fonts/truetype</dir>
  <dir>/texmf-dist/fonts/type1</dir>
  <cachedir>/tmp/fontcache</cachedir>
  <config>
    <rescan><int>0</int></rescan>
  </config>
</fontconfig>
`;

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
  /**
   * The wasm compiled ONCE per worker. Every run needs a fresh Emscripten
   * *instance* (engines aren't reentrant), but without this cache the glue
   * re-fetches and re-compiles the multi-MB binary each time — WKWebView
   * has no wasm code cache, so on iOS that's a full compile per run.
   * null → the glue manages its own loading (fallback).
   */
  private wasmModule: WebAssembly.Module | null = null;
  private icuData: Uint8Array | null = null;
  /** TDS-relative path → bytes; repopulated into every fresh instance. */
  private tdsFiles = new Map<string, Uint8Array>();
  /**
   * /tmp/texmf-var contents harvested after each run and re-seeded into the
   * next fresh instance — luaotfload's font-name database alone is worth
   * multi-second rebuilds otherwise. Worker-scoped, so it can never outlive
   * the TDS it was built from (a TDS change means a new worker + init()).
   */
  private varFiles = new Map<string, Uint8Array>();
  /**
   * basename → full TDS paths, built from the manifest (config.manifestUrl).
   * The lazy-fetch retry resolves log-reported names ("lmodern.sty") to
   * exact backend paths through this instead of guessing locations; the
   * guessing heuristic stays as fallback for unindexed names.
   */
  private nameIndex = new Map<string, string[]>();
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

    // Compile the wasm once up front (see wasmModule doc). Any failure —
    // exotic URL scheme, missing CORS, Node file:// — falls back to the
    // glue's own loader, which is correct just slower.
    if (this.config.enginePath) {
      try {
        const r = await fetch(this.config.enginePath);
        if (r.ok) {
          this.wasmModule = await WebAssembly.compile(await r.arrayBuffer());
        }
      } catch {
        this.wasmModule = null;
      }
    }

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

    // Optional precise-resolution index for the lazy-fetch retry. Failure is
    // non-fatal: the heuristic resolver still works, just less precisely.
    if (opts.config.manifestUrl) {
      try {
        const manifest = await loadManifest(opts.config.manifestUrl);
        for (const path of Object.keys(manifest.files)) {
          const name = path.slice(path.lastIndexOf('/') + 1);
          const existing = this.nameIndex.get(name);
          if (existing) existing.push(path);
          else this.nameIndex.set(name, [path]);
        }
      } catch {
        this.nameIndex.clear();
      }
    }
  }

  /** Build a fresh engine instance with the TDS + ICU state applied. */
  private async createInstance(): Promise<EmscriptenModule> {
    if (!this.engineId || !this.glueFactory) {
      throw new Error('Worker.init() must be called before run()');
    }
    const cachedModule = this.wasmModule;
    const module = await this.glueFactory({
      noInitialRun: true,
      thisProgram: `/bin/${this.engineId}`,
      print: (line: string) => {
        this.stdoutBuf += line + '\n';
      },
      printErr: (line: string) => {
        this.stderrBuf += line + '\n';
      },
      // Instantiate from the worker-cached Module instead of letting the
      // glue re-fetch + re-compile the binary for every fresh instance.
      ...(cachedModule
        ? {
            instantiateWasm: (
              imports: WebAssembly.Imports,
              done: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
            ) => {
              void WebAssembly.instantiate(cachedModule, imports).then((instance) =>
                done(instance, cachedModule),
              );
              return {}; // async instantiation — exports arrive via done()
            },
          }
        : {}),
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
    // XeTeX resolves by-name font requests through fontconfig, which hard-
    // fails at startup without a config file ("cannot read font names").
    // Point it at the TDS font trees; both paths are probed by our build
    // (/etc/fonts and the --prefix=/usr/local default).
    if (this.engineId === 'xelatex') {
      mkdirCached(FS, '/etc/fonts', dirs);
      mkdirCached(FS, '/usr/local/etc/fonts', dirs);
      mkdirCached(FS, '/tmp/fontcache', dirs);
      FS.writeFile('/etc/fonts/fonts.conf', FONTS_CONF);
      FS.writeFile('/usr/local/etc/fonts/fonts.conf', FONTS_CONF);
    }
    if (!pathExists(FS, '/tmp')) FS.mkdir('/tmp');
    dirs.add('/tmp');
    // Writable cache root for luaotfload and friends (see TEXMFVAR/
    // TEXMFCACHE -cnf-line args in run()); re-seed the caches harvested
    // from previous runs so they don't get rebuilt from scratch.
    mkdirCached(FS, '/tmp/texmf-var', dirs);
    for (const [rel, bytes] of this.varFiles) {
      const absolute = `/tmp/texmf-var/${rel}`;
      mkdirCached(FS, dirname(absolute), dirs);
      FS.writeFile(absolute, bytes);
    }
    mkdirCached(FS, '/texmf-dist', dirs);

    // biber's VFS (biber-vfs.tar.gz: perl/ + biber/ trees) mounts at the
    // filesystem ROOT — it is a Perl runtime, not a texmf tree. Everything
    // else is TDS-relative under /texmf-dist.
    const fsRoot = this.engineId === 'biber' ? '' : '/texmf-dist';
    for (const [tdsPath, bytes] of this.tdsFiles) {
      const absolute = `${fsRoot}/${tdsPath}`;
      mkdirCached(FS, dirname(absolute), dirs);
      FS.writeFile(absolute, bytes);
    }
    if (this.engineId !== 'biber') {
      // Regenerate the kpathsea filename database from what is ACTUALLY in
      // the map — any bundled ls-R is stale the moment the lazy-fetch retry
      // adds a file, and with $TEXMFDBS set the db is authoritative. Keeping
      // it exact turns every `//` search into an O(1) db hit.
      FS.writeFile('/texmf-dist/ls-R', buildLsR(this.tdsFiles.keys()));
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
    // the TDS map, and re-run — on a fresh instance, like every run. One
    // retry resolves everything a nonstopmode pass reported; raise
    // maxRetries when packages pull in further missing files transitively
    // (cheap with local backends like TauriFS).
    const lazy = opts.lazyFetch ?? true;
    const maxRetries = lazy === false ? 0 : lazy === true ? 1 : Math.max(0, lazy.maxRetries ?? 1);
    let exitCode = 0;
    let retriesUsed = 0;
    let stdout = '';
    let stderr = '';
    let outputs = new Map<string, Uint8Array>();
    let log = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let module: EmscriptenModule;
      let FS: EmscriptenFS;
      try {
        module = await this.createInstance();
        FS = module.FS;
        for (const file of opts.files ?? []) {
          const absolute = `/project/${stripLeadingSlash(file.path)}`;
          mkdirP(FS, dirname(absolute));
          FS.writeFile(absolute, normalizeBytes(file.content));
        }
      } catch (err) {
        rethrowIfOom(err);
        throw err;
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
          rethrowIfOom(err);
          throw err;
        }
      }
      stdout += this.stdoutBuf;
      stderr += this.stderrBuf;

      outputs = new Map<string, Uint8Array>();
      collectFiles(FS, '/project', '', outputs);
      log = findLog(FS, opts.args);

      // Harvest engine-written caches (luaotfload font db, etc.) for the
      // next instance — even failed compiles usually completed the cache
      // build, so harvest unconditionally.
      if (this.config?.persistTexmfVar !== false) {
        try {
          collectFiles(FS, '/tmp/texmf-var', '', this.varFiles);
        } catch {
          // A run that never touched the cache dir is fine.
        }
      }

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
      // The ls-R we regenerate per instance is exact, so db lookups are
      // authoritative and every recursive `//` search below becomes a hash
      // hit instead of a MEMFS directory walk.
      '-cnf-line=TEXMFDBS=/texmf-dist',
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
      // Exact manifest paths first; heuristic location guessing as fallback.
      const indexed = name.includes('/') ? [] : (this.nameIndex.get(name) ?? []);
      const candidates = [...indexed, ...expandMissingName(name)];
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
    this.wasmModule = null;
    this.tdsFiles.clear();
    this.varFiles.clear();
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

/**
 * Emscripten reports heap-growth failure as an abort ("Cannot enlarge memory
 * arrays", "OOM") or a bare RangeError from WebAssembly.Memory.grow. Rethrow
 * those under a stable name (Comlink preserves name/message across the worker
 * boundary) so apps can react — dispose idle engines, retry — instead of
 * treating it as an opaque engine crash.
 */
function rethrowIfOom(err: unknown): void {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (err instanceof RangeError || /cannot enlarge memory|out of memory|\bOOM\b/i.test(text)) {
    const oom = new Error(
      `engine ran out of memory (${text}); dispose idle engines or reduce concurrent workers, then retry`,
    );
    oom.name = 'EngineOutOfMemoryError';
    throw oom;
  }
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
