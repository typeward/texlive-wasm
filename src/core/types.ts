/**
 * Shared type definitions.
 */

export type EngineId = 'pdflatex' | 'xelatex' | 'lualatex' | 'bibtexu' | 'xdvipdfmx' | 'makeindex';

export interface EngineConfig {
  /** URL or absolute path of the engine `.wasm` artifact. */
  enginePath?: string;
  /** URL or absolute path of the engine's pre-built `.fmt` file (LaTeX format). */
  fmtPath?: string;
  /** URL or absolute path of the `tex-packages.json` manifest. */
  manifestUrl?: string;
  /**
   * URL of `icudt78l.dat` (ICU locale data). Only used by ICU engines
   * (xelatex, bibtexu); without it, locale-specific ICU APIs return
   * U_MISSING_RESOURCE_ERROR but basic operation still works.
   */
  icuDataUrl?: string;
  /** When supplied, FETCHFS uses this as the CDN base for long-tail packages. */
  cdnBaseUrl?: string;
  /** Whether to use a Web Worker (default: true in browser, false in Node). */
  useWorker?: boolean;
  /** Verbosity for engine stdout/stderr piped through the wrapper. */
  verbose?: 'silent' | 'info' | 'debug';
  /**
   * Optional explicit VFS layer chain. If omitted, defaults to
   * [BundleFS(core), TauriFS or OPFS if available, FETCHFS if cdnBaseUrl set].
   */
  vfs?: VfsBackend[];
}

export interface FileInput {
  /** Path inside `/project` (relative). */
  path: string;
  content: string | Uint8Array;
}

export interface RunOptions {
  /** argv after the program name. e.g. ['--no-shell-escape', 'main.tex']. */
  args: string[];
  /** Files dropped into /project before the engine starts. */
  files?: FileInput[];
  /** Working directory inside the engine. Default: `/project`. */
  cwd?: string;
  /** stdin payload. Reserved — not implemented yet. */
  stdin?: string | Uint8Array;
  /**
   * kpathsea variable overrides (TEXINPUTS, TEXMFCNF, ...). Injected as
   * `-cnf-line=KEY=VAL` args for the TeX engines; ignored for bibtexu,
   * xdvipdfmx and makeindex (Emscripten freezes real env vars at init).
   */
  env?: Record<string, string>;
  /**
   * Maximum wall-clock time before the run is aborted, in ms. The engine
   * runs synchronously inside its worker, so aborting terminates the worker
   * — the handle is unusable afterwards and must be recreated.
   */
  timeoutMs?: number;
  /**
   * If true (default), the worker parses missing-file errors out of the .log
   * after a failed compile, asks the VFS backends for those paths, writes
   * them into MEMFS, and retries the compile once. Set false to disable.
   */
  lazyFetch?: boolean;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Files the engine wrote under /project, keyed by path. */
  outputs: Map<string, Uint8Array>;
  /** Convenience: concatenated TeX `.log` if present. */
  log: string;
  /** Wall-clock duration of the engine invocation. */
  durationMs: number;
  /** How many lazy-fetch retries the worker had to perform. */
  lazyFetchRetries?: number;
}

export interface LogEntry {
  cmd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  log: string;
}

export interface CompileResult {
  success: boolean;
  pdf?: Uint8Array;
  synctex?: Uint8Array;
  log: string;
  logs: LogEntry[];
  exitCode: number;
}

/**
 * A pluggable VFS backend mounted under `/texmf-dist`.
 *
 * Layers are consulted in order; the first one that resolves wins.
 * Implementations may be sync or async. Backends that expose list() are
 * drained into MEMFS when the engine initializes; the others are consulted
 * on demand by the lazy-fetch retry after a failed pass (see worker.ts).
 */
export interface VfsBackend {
  readonly id: string;
  /**
   * Returns the file contents if the backend has it, otherwise null.
   * Implementations should NOT throw on missing files.
   */
  read(tdsPath: string): Promise<Uint8Array | null> | Uint8Array | null;
  /** Cheap existence check; default is to attempt a read. */
  exists?(tdsPath: string): Promise<boolean> | boolean;
  /** Optional: enumerate all known paths under a TDS subtree. */
  list?(tdsPrefix: string): Promise<string[]> | string[];
  /** Optional: invoked once when the engine initializes. */
  init?(): Promise<void> | void;
  /** Optional: invoked when the engine is disposed. */
  dispose?(): Promise<void> | void;
}

export interface EngineHandle {
  readonly id: EngineId;
  readonly config: Readonly<EngineConfig>;
  /** Direct argv invocation. */
  run(options: RunOptions): Promise<RunResult>;
  /** Release the worker and any allocated WASM heap. */
  dispose(): Promise<void>;
  /** Whether the underlying worker/module has been instantiated. */
  isReady(): boolean;
}
