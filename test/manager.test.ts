import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle, EngineId } from '../src/core/types';

const created: EngineId[] = [];
const disposed: EngineId[] = [];
let failFor: EngineId | null = null;

vi.mock('../src/core/engine', () => ({
  createEngine: async (id: EngineId): Promise<EngineHandle> => {
    if (failFor === id) throw new Error(`boom ${id}`);
    created.push(id);
    return {
      id,
      config: {},
      run: async () => {
        throw new Error('not used in this test');
      },
      dispose: async () => {
        disposed.push(id);
      },
      isReady: () => true,
    };
  },
}));

import { createEngineManager } from '../src/core/manager';

beforeEach(() => {
  created.length = 0;
  disposed.length = 0;
  failFor = null;
});

const config = () => ({});

describe('createEngineManager', () => {
  it('memoizes handles per engine', async () => {
    const mgr = createEngineManager({ config });
    const a = await mgr.engine('pdflatex');
    const b = await mgr.engine('pdflatex');
    expect(a).toBe(b);
    expect(created).toEqual(['pdflatex']);
  });

  it('evicts the least-recently-used idle engine at the cap', async () => {
    const evicted: EngineId[] = [];
    const mgr = createEngineManager({
      config,
      maxLiveEngines: 2,
      onEvict: (id) => evicted.push(id),
    });
    await mgr.engine('pdflatex');
    await mgr.engine('bibtexu');
    await mgr.engine('pdflatex'); // bump pdflatex → bibtexu is now LRU
    await mgr.engine('makeindex'); // over cap → bibtexu evicted
    expect(evicted).toEqual(['bibtexu']);
    await vi.waitFor(() => expect(disposed).toContain('bibtexu'));
    expect(mgr.live().sort()).toEqual(['makeindex', 'pdflatex']);
  });

  it('never evicts engines pinned by withEngines', async () => {
    const evicted: EngineId[] = [];
    const mgr = createEngineManager({
      config,
      maxLiveEngines: 1,
      onEvict: (id) => evicted.push(id),
    });
    await mgr.withEngines(['pdflatex', 'bibtexu'], async (handles) => {
      expect(handles.size).toBe(2);
      // Cap is 1 but both are pinned — nothing may be evicted mid-pipeline.
      await mgr.engine('makeindex');
      expect(evicted).not.toContain('pdflatex');
      expect(evicted).not.toContain('bibtexu');
    });
    // After unpinning, new demand can evict them again.
    await mgr.engine('xdvipdfmx');
    expect(evicted.length).toBeGreaterThan(0);
  });

  it('a failed init does not poison the slot', async () => {
    const mgr = createEngineManager({ config });
    failFor = 'lualatex';
    await expect(mgr.engine('lualatex')).rejects.toThrow('boom');
    failFor = null;
    await expect(mgr.engine('lualatex')).resolves.toBeDefined();
  });

  it('dispose() without id tears everything down', async () => {
    const mgr = createEngineManager({ config });
    await mgr.engine('pdflatex');
    await mgr.engine('bibtexu');
    await mgr.dispose();
    expect(disposed.sort()).toEqual(['bibtexu', 'pdflatex']);
    expect(mgr.live()).toEqual([]);
  });
});
