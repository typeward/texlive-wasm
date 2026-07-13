/**
 * A fake Emscripten module for the worker tests: enough of WASMFS + the
 * lazy-TDS backend to exercise src/core/worker.ts's filesystem orchestration
 * without a 1.3 MB engine.
 *
 * The semantics that matter are copied from the real thing, verified against
 * the deployed pdflatex artifact:
 *  - FS.mkdir is mkdir(2): it fails on an existing path.
 *  - texlive_mount_lazy() returns -EEXIST (-20) when /texmf-dist already
 *    exists, because wasmfs_create_directory is mkdir-like too. This is the
 *    exact failure that silently disabled lazy mounting.
 *  - texlive_touch() creates an empty node whose bytes live JS-side; reads go
 *    through the embedder handler (Module.texliveLazyBackend).
 */

const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;

export interface FakeStats {
  /** Bytes written into /texmf-dist through the heap (i.e. eager materialization). */
  eagerTdsBytes: number;
  /** Nodes created through the lazy backend. */
  touched: number;
  /** Whether texlive_mount_lazy() succeeded. */
  mounted: boolean;
  /** Order of interesting FS events, for ordering assertions. */
  events: string[];
}

export interface FakeModuleOptions {
  /** Engine behavior: write outputs into the FS and return an exit code. */
  callMain?: (args: string[], fs: FakeFs) => number;
  /** Omit the lazy exports, like a pre-M2 artifact. */
  withoutLazyBackend?: boolean;
}

export interface FakeFs {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number };
  chdir(path: string): void;
  unlink(path: string): void;
}

interface LazyHandler {
  allocFile(file: number): void;
  freeFile(file: number): void;
  getSize(file: number): number;
  read(file: number, buffer: number, length: number, offset: number): number;
  write(file: number, buffer: number, length: number, offset: number): number;
  setSize(file: number, size: number): number;
}

export function createFakeModule(options: FakeModuleOptions = {}) {
  const dirs = new Set<string>(['/']);
  const files = new Map<string, Uint8Array>();
  /** Paths whose bytes live JS-side, in the handler — not in the heap. */
  const lazyIds = new Map<string, number>();
  const heap = new Uint8Array(4 * 1024 * 1024);
  let brk = 8;
  let nextFileId = 1;
  let cwd = '/';

  const stats: FakeStats = { eagerTdsBytes: 0, touched: 0, mounted: false, events: [] };

  const handler = (): LazyHandler | undefined =>
    (module as { texliveLazyBackend?: LazyHandler }).texliveLazyBackend;

  const enc = new TextEncoder();

  const fs: FakeFs = {
    mkdir(path) {
      if (dirs.has(path) || files.has(path)) throw new Error(`EEXIST: ${path}`);
      if (path.startsWith('/texmf-dist')) stats.events.push(`mkdir ${path}`);
      dirs.add(path);
    },
    writeFile(path, data) {
      const bytes = typeof data === 'string' ? enc.encode(data) : data;
      const lazyId = lazyIds.get(path);
      if (stats.mounted && path.startsWith('/texmf-dist/')) {
        // Under the mount, a write is copy-on-write into the JS handler (the
        // regenerated ls-R lands here), not a heap allocation.
        const h = handler()!;
        let id = lazyId;
        if (id === undefined) {
          id = nextFileId++;
          lazyIds.set(path, id);
          h.allocFile(id);
        }
        heap.set(bytes, brk);
        h.write(id, brk, bytes.length, 0);
        return;
      }
      if (path.startsWith('/texmf-dist/')) stats.eagerTdsBytes += bytes.length;
      files.set(path, bytes.slice());
    },
    readFile(path) {
      const id = lazyIds.get(path);
      if (id !== undefined) {
        const h = handler()!;
        const size = h.getSize(id);
        const n = h.read(id, brk, size, 0);
        return heap.slice(brk, brk + n);
      }
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT: ${path}`);
      return bytes.slice();
    },
    readdir(path) {
      const prefix = path === '/' ? '/' : path + '/';
      const names = new Set<string>();
      for (const p of [...files.keys(), ...lazyIds.keys(), ...dirs]) {
        if (p === path || !p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const head = rest.split('/')[0];
        if (head) names.add(head);
      }
      return [...names];
    },
    stat(path) {
      if (dirs.has(path)) return { mode: S_IFDIR, size: 0 };
      const id = lazyIds.get(path);
      if (id !== undefined) return { mode: S_IFREG, size: handler()!.getSize(id) };
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT: ${path}`);
      return { mode: S_IFREG, size: bytes.length };
    },
    chdir(path) {
      cwd = path;
    },
    unlink(path) {
      files.delete(path);
      lazyIds.delete(path);
    },
  };

  const lazyExports = options.withoutLazyBackend
    ? {}
    : {
        _texlive_mount_lazy(): number {
          // wasmfs_create_directory is mkdir-like: mounting onto an existing
          // directory is -EEXIST, and the tree stays eager.
          if (dirs.has('/texmf-dist')) {
            stats.events.push('mount EEXIST');
            return -20;
          }
          dirs.add('/texmf-dist');
          stats.mounted = true;
          stats.events.push('mount ok');
          return 0;
        },
        _texlive_touch(ptr: number): number {
          if (!stats.mounted) return -1;
          const path = readCString(heap, ptr);
          const id = nextFileId++;
          lazyIds.set(path, id);
          handler()!.allocFile(id);
          stats.touched++;
          return 0;
        },
        stringToUTF8(str: string, ptr: number, _max: number): void {
          const bytes = enc.encode(str);
          heap.set(bytes, ptr);
          heap[ptr + bytes.length] = 0;
        },
      };

  const module = {
    FS: fs,
    ENV: {} as Record<string, string>,
    HEAPU8: heap,
    HEAPU32: new Uint32Array(heap.buffer),
    _malloc(size: number): number {
      const ptr = brk;
      brk += size + 8;
      return ptr;
    },
    _free(_ptr: number): void {},
    callMain(args: string[]): number {
      return options.callMain ? options.callMain(args, fs) : 0;
    },
    ...lazyExports,
    /** Test-only handles. */
    __stats: stats,
    __cwd: () => cwd,
  };
  return module;
}

function readCString(heap: Uint8Array, ptr: number): string {
  let end = ptr;
  while (heap[end] !== 0) end++;
  return new TextDecoder().decode(heap.subarray(ptr, end));
}
