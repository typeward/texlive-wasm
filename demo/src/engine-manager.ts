/**
 * The dogfooding layer: everything the showcase does with TeX goes through
 * the actual `texlive-wasm` npm API from here — createEngine + latexmk with
 * per-engine Web Workers, exactly as a consumer app would use it.
 */

import { createEngine, latexmk, willRunBibtex, willRunBiber } from '@typeward/texlive-wasm';
import type {
  EngineHandle,
  EngineId,
  FileInput,
  LatexmkEngine,
  LatexmkOptions,
  LatexmkResult,
} from '@typeward/texlive-wasm';
import { createSignal } from 'solid-js';

/** Human-readable artifact sizes for status messages (see README table). */
export const ENGINE_SIZES: Record<EngineId, string> = {
  pdflatex: '1.3 MB',
  xelatex: '2.8 MB',
  lualatex: '4.8 MB',
  bibtexu: '0.9 MB',
  xdvipdfmx: '0.8 MB',
  makeindex: '0.2 MB',
  biber: '9.1 MB + 14 MB VFS',
};

/**
 * Runtime assets live under core/ next to index.html (vite middleware in dev,
 * files staged by deploy-site.yml on Pages). URLs must be absolute because
 * the library worker resolves enginePath against the *worker script* URL.
 */
const coreUrl = (p: string) => new URL(`core/${p}`, document.baseURI).href;

export const [engineStatus, setEngineStatus] = createSignal<string>('');
export const [tdsProgress, setTdsProgress] = createSignal<{
  loaded: number;
  total: number;
} | null>(null);
export const [tdsReady, setTdsReady] = createSignal(false);

/**
 * Warm the browser HTTP cache for the TDS bundle with a byte-accurate
 * progress bar. The engine workers then fetch the same URL themselves
 * (EngineConfig.bundleUrl) and hit the cache instead of the network.
 */
let tdsWarm: Promise<void> | null = null;
export function warmTds(): Promise<void> {
  tdsWarm ??= (async () => {
    const url = coreUrl('texmf.tar.gz');
    const r = await fetch(url);
    if (!r.ok) {
      throw new Error(
        `TDS bundle missing (HTTP ${r.status} for core/texmf.tar.gz). ` +
          `See demo/README.md for how to stage the runtime assets.`,
      );
    }
    const total = Number(r.headers.get('content-length') ?? 0);
    if (r.body && total > 0) {
      const reader = r.body.getReader();
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded += value.byteLength;
        setTdsProgress({ loaded, total });
      }
    } else {
      await r.arrayBuffer();
    }
    setTdsProgress(null);
    setTdsReady(true);
  })().catch((err) => {
    tdsWarm = null; // allow retry on the next compile
    setTdsProgress(null);
    throw err;
  });
  return tdsWarm;
}

interface Slot {
  promise: Promise<EngineHandle>;
  busy: number;
  lastUsed: number;
}

/**
 * Lazy, memoized engine handles with a small LRU cap: each worker drains the
 * full TDS into its own in-memory FS, so keeping all six alive is expensive.
 * Busy engines are never evicted.
 */
const slots = new Map<EngineId, Slot>();
const MAX_LIVE_ENGINES = 3;
let clock = 0;

export function getEngine(id: EngineId): Promise<EngineHandle> {
  const existing = slots.get(id);
  if (existing) {
    existing.lastUsed = ++clock;
    return existing.promise;
  }
  evictIdleEngine();
  setEngineStatus(`loading ${id}.wasm (${ENGINE_SIZES[id]}) + unpacking TeX tree…`);
  const promise = createEngine(id, {
    enginePath: coreUrl(`${id}/emscripten/${id}.wasm`),
    // biber's bundle is its Perl runtime VFS, not the TeX tree.
    bundleUrl: id === 'biber' ? coreUrl('biber/emscripten/biber-vfs.tar.gz') : coreUrl('texmf.tar.gz'),
    ...(id === 'xelatex' || id === 'bibtexu' ? { icuDataUrl: coreUrl('icudt78l.dat') } : {}),
  }).then((handle) => {
    setEngineStatus(`${id} ready`);
    return handle;
  });
  slots.set(id, { promise, busy: 0, lastUsed: ++clock });
  // A failed init must not poison the slot forever.
  promise.catch(() => slots.delete(id));
  return promise;
}

function evictIdleEngine(): void {
  if (slots.size < MAX_LIVE_ENGINES) return;
  let victim: EngineId | null = null;
  let oldest = Infinity;
  for (const [id, slot] of slots) {
    if (slot.busy === 0 && slot.lastUsed < oldest) {
      oldest = slot.lastUsed;
      victim = id;
    }
  }
  if (!victim) return; // everything is busy — allow the extra engine
  const slot = slots.get(victim)!;
  slots.delete(victim);
  void slot.promise.then((h) => h.dispose()).catch(() => {});
}

function markBusy(ids: EngineId[], delta: number): void {
  for (const id of ids) {
    const slot = slots.get(id);
    if (slot) slot.busy += delta;
  }
}

export interface CompileRequest {
  engine: LatexmkEngine;
  mainTex: string;
  files: FileInput[];
  synctex?: boolean;
}

/**
 * Compile through `latexmk`. The driver would create helper wrappers without
 * an enginePath (which throws — no artifact ships in the npm package), so we
 * mirror its auto-detection, pre-create every needed handle ourselves, and
 * hand them all over.
 */
export async function compile(req: CompileRequest): Promise<LatexmkResult> {
  await warmTds();

  const src = req.files.map((f) => (typeof f.content === 'string' ? f.content : '')).join('\n');
  // Use the library's own detection (classic \bibliography AND biblatex
  // backend=bibtex vs default-backend biber) so the pre-created handles
  // always match what latexmk will actually invoke.
  const needBib = willRunBibtex(req.files);
  const needBiber = willRunBiber(req.files);
  const needIdx = src.includes('\\makeindex') || src.includes('\\printindex');
  // Plain documents (no refs/TOC/citations) are done in one pass — skip the
  // aux-stabilization pass latexmk would otherwise spend proving that.
  const mayNeedRerun =
    needBib || needIdx || /\\(tableofcontents|ref|pageref|cite|label)\b/.test(src);

  const involved: EngineId[] = [req.engine];
  if (needBib) involved.push('bibtexu');
  if (needBiber) involved.push('biber');
  if (needIdx) involved.push('makeindex');
  if (req.engine === 'xelatex') involved.push('xdvipdfmx');

  const handles: NonNullable<LatexmkOptions['handles']> = {
    tex: await getEngine(req.engine),
  };
  if (needBib) handles.bibtex = await getEngine('bibtexu');
  if (needBiber) handles.biber = await getEngine('biber');
  if (needIdx) handles.makeindex = await getEngine('makeindex');
  if (req.engine === 'xelatex') handles.xdvipdfmx = await getEngine('xdvipdfmx');

  markBusy(involved, +1);
  setEngineStatus(`compiling with ${req.engine}…`);
  try {
    const result = await latexmk({
      engine: req.engine,
      mainTex: req.mainTex,
      files: req.files,
      bibtex: needBib,
      biber: needBiber,
      makeindex: needIdx,
      rerun: mayNeedRerun ? 'auto' : false,
      ...(req.synctex ? { synctex: true } : {}),
      handles,
    });
    setEngineStatus(
      result.success ? `done — ${result.passes} pass(es)` : `failed (exit ${result.exitCode})`,
    );
    return result;
  } finally {
    markBusy(involved, -1);
  }
}
