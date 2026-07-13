/**
 * latexmk without `handles`: the README's headline example. Every engine is a
 * separate wasm artifact, so latexmk can only build one if it is told where
 * that artifact lives — before `engineConfig` existed, this path could not
 * construct an engine at all and threw on the first pass.
 *
 * createEngine is mocked because the real one needs a Worker; what is under
 * test is that the config reaches it, for the helpers as well as the engine.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineConfig, EngineHandle, EngineId, RunResult } from '../src/core/types';

const builds: { id: EngineId; config: EngineConfig }[] = [];

vi.mock('../src/core/engine', () => ({
  createEngine: async (id: EngineId, config: EngineConfig): Promise<EngineHandle> => {
    builds.push({ id, config });
    return {
      id,
      config,
      run: async (): Promise<RunResult> => {
        const outputs = new Map<string, Uint8Array>();
        const enc = (s: string) => new TextEncoder().encode(s);
        if (id === 'makeindex') outputs.set('main.ind', enc('IND'));
        else {
          outputs.set('main.aux', enc('A'));
          outputs.set('main.idx', enc('IDX'));
          outputs.set('main.log', enc('clean'));
          outputs.set('main.pdf', enc('PDF'));
        }
        return { exitCode: 0, stdout: '', stderr: '', outputs, log: 'clean', durationMs: 1 };
      },
      dispose: async () => {},
      isReady: () => true,
    };
  },
}));

import { latexmk } from '../src/latexmk';

beforeEach(() => {
  builds.length = 0;
});

describe('latexmk engine construction', () => {
  it('builds its engines from a single EngineConfig', async () => {
    const result = await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: 'plain doc' }],
      engineConfig: { enginePath: '/assets/pdflatex.wasm', bundleUrl: '/assets/texmf.tar.gz' },
    });

    expect(result.success).toBe(true);
    expect(builds).toHaveLength(1);
    expect(builds[0]!.id).toBe('pdflatex');
    expect(builds[0]!.config.enginePath).toBe('/assets/pdflatex.wasm');
    expect(builds[0]!.config.bundleUrl).toBe('/assets/texmf.tar.gz');
  });

  it('builds each helper from the per-engine factory', async () => {
    const result = await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: '\\makeindex\\printindex' }],
      engineConfig: (id) => ({
        enginePath: `/assets/${id}/${id}.wasm`,
        bundleUrl: `/assets/texmf-core-${id}.tar.gz`,
      }),
    });

    expect(result.success).toBe(true);
    const byId = new Map(builds.map((b) => [b.id, b.config]));
    // The helper needs its OWN artifact — a makeindex that got pdflatex's
    // enginePath would load the wrong wasm.
    expect(byId.get('pdflatex')?.enginePath).toBe('/assets/pdflatex/pdflatex.wasm');
    expect(byId.get('makeindex')?.enginePath).toBe('/assets/makeindex/makeindex.wasm');
    expect(byId.get('makeindex')?.bundleUrl).toBe('/assets/texmf-core-makeindex.tar.gz');
  });

  it('prefers a supplied handle over building one', async () => {
    const tex: EngineHandle = {
      id: 'pdflatex',
      config: {},
      run: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        outputs: new Map([['main.pdf', new TextEncoder().encode('PDF')]]),
        log: 'clean',
        durationMs: 1,
      }),
      dispose: async () => {},
      isReady: () => true,
    };

    await latexmk({
      engine: 'pdflatex',
      mainTex: 'main.tex',
      files: [{ path: 'main.tex', content: 'doc' }],
      engineConfig: { enginePath: '/assets/pdflatex.wasm' },
      handles: { tex },
    });

    expect(builds).toHaveLength(0);
  });
});
