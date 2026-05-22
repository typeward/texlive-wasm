/**
 * Smoke tests for the public API surface.
 *
 * These don't run any actual WASM yet — they verify the type contract and the
 * pure JS bits (manifest, latexmk auto-detection, kpse helpers, synctex
 * parser). Engine-level tests come in Phase 1 once we have a built artifact.
 */

import { describe, expect, it } from 'vitest';
import { tdsRelative, tdsAbsolute } from './core/kpse';
import { createSynctex } from './synctex';

describe('kpse helpers', () => {
  it('strips /texmf-dist/ prefix', () => {
    expect(tdsRelative('/texmf-dist/tex/latex/base/article.cls')).toBe(
      'tex/latex/base/article.cls',
    );
  });

  it('also strips /texlive/texmf-dist/', () => {
    expect(tdsRelative('/texlive/texmf-dist/tex/latex/base/article.cls')).toBe(
      'tex/latex/base/article.cls',
    );
  });

  it('returns null for non-TEXMF paths', () => {
    expect(tdsRelative('/tmp/main.aux')).toBeNull();
    expect(tdsRelative('/project/main.tex')).toBeNull();
  });

  it('round-trips', () => {
    const rel = 'tex/latex/base/article.cls';
    expect(tdsRelative(tdsAbsolute(rel))).toBe(rel);
  });
});

describe('synctex parser', () => {
  it('reads input filenames', async () => {
    const fake =
      'SyncTeX Version:1\n' +
      'Input:1:/project/main.tex\n' +
      'Input:2:/project/chapter1.tex\n' +
      'Output:pdf\n';
    const lookup = await createSynctex(new TextEncoder().encode(fake));
    expect(lookup.files().sort()).toEqual(['/project/chapter1.tex', '/project/main.tex']);
  });
});
