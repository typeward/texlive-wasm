/**
 * Engine lifecycle manager: lazy, memoized handles with an LRU cap.
 *
 * Every engine worker holds its own copy of the TDS in memory (the map it
 * drains at init plus the MEMFS materialization during runs), so keeping
 * all six engines alive is expensive — on mobile WebViews it is fatal.
 * The manager keeps at most `maxLiveEngines` workers alive, evicting the
 * least-recently-used idle one before creating the next. Engines pinned by
 * an in-flight `withEngines()` scope are never evicted; when everything is
 * pinned the cap is temporarily exceeded rather than deadlocking.
 */

import { createEngine } from './engine';
import type { EngineConfig, EngineHandle, EngineId } from './types';

export interface EngineManagerOptions {
  /** Builds the EngineConfig for an engine the first time it is needed. */
  config: (id: EngineId) => EngineConfig;
  /**
   * Maximum live engine workers. Default: 3 — a desktop-browser trade-off.
   * Mobile WebViews (Tauri iOS/Android) should use 1: one live worker is
   * roughly "TDS bytes + wasm heap" of resident memory.
   */
  maxLiveEngines?: number;
  /** Diagnostics: an idle engine was evicted to make room. */
  onEvict?: (id: EngineId) => void;
  /** Diagnostics: a new engine worker starts loading. */
  onLoad?: (id: EngineId) => void;
}

export interface EngineManager {
  /** Lazy, memoized handle; marks the engine most-recently-used. */
  engine(id: EngineId): Promise<EngineHandle>;
  /**
   * Acquire several engines and pin them for the duration of `fn` — a
   * multi-engine pipeline (latexmk: tex + bibtex + makeindex + xdvipdfmx)
   * must not have a helper evicted mid-run by another compile.
   */
  withEngines<T>(
    ids: EngineId[],
    fn: (handles: Map<EngineId, EngineHandle>) => Promise<T>,
  ): Promise<T>;
  /** Engines currently alive (loaded or still loading). */
  live(): EngineId[];
  /** Dispose one engine, or every engine when no id is given. */
  dispose(id?: EngineId): Promise<void>;
}

interface Slot {
  promise: Promise<EngineHandle>;
  pins: number;
  lastUsed: number;
}

export function createEngineManager(options: EngineManagerOptions): EngineManager {
  const maxLive = Math.max(1, options.maxLiveEngines ?? 3);
  const slots = new Map<EngineId, Slot>();
  let clock = 0;

  function get(id: EngineId): Slot {
    const existing = slots.get(id);
    if (existing) {
      existing.lastUsed = ++clock;
      return existing;
    }
    evictIdle();
    options.onLoad?.(id);
    const promise = createEngine(id, options.config(id));
    const slot: Slot = { promise, pins: 0, lastUsed: ++clock };
    slots.set(id, slot);
    // A failed init must not poison the slot forever.
    promise.catch(() => {
      if (slots.get(id) === slot) slots.delete(id);
    });
    return slot;
  }

  function evictIdle(): void {
    if (slots.size < maxLive) return;
    let victim: EngineId | null = null;
    let oldest = Infinity;
    for (const [id, slot] of slots) {
      if (slot.pins === 0 && slot.lastUsed < oldest) {
        oldest = slot.lastUsed;
        victim = id;
      }
    }
    if (!victim) return; // everything is pinned — allow the extra engine
    const slot = slots.get(victim)!;
    slots.delete(victim);
    options.onEvict?.(victim);
    void slot.promise.then((h) => h.dispose()).catch(() => {});
  }

  return {
    engine: (id) => get(id).promise,

    async withEngines(ids, fn) {
      // Pin before awaiting anything so a concurrent compile can't evict a
      // handle we are still constructing.
      const pinned = ids.map((id) => {
        const slot = get(id);
        slot.pins++;
        return slot;
      });
      try {
        const handles = new Map<EngineId, EngineHandle>();
        for (let i = 0; i < ids.length; i++) {
          handles.set(ids[i]!, await pinned[i]!.promise);
        }
        return await fn(handles);
      } finally {
        for (const slot of pinned) slot.pins--;
      }
    },

    live: () => [...slots.keys()],

    async dispose(id) {
      const targets = id ? [id] : [...slots.keys()];
      await Promise.allSettled(
        targets.map((t) => {
          const slot = slots.get(t);
          if (!slot) return Promise.resolve();
          slots.delete(t);
          return slot.promise.then((h) => h.dispose());
        }),
      );
    },
  };
}
