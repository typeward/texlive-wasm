import { describe, expect, it } from 'vitest';
import { globMatch, classify, inferPackage } from '../scripts/build-manifest';

describe('globMatch', () => {
  it('matches files below a trailing dir/** pattern', () => {
    // Regression: the old implementation compiled a trailing ** to a
    // pattern that only matched paths ending in '/', so no file ever hit.
    expect(globMatch('tex/latex/base/**', 'tex/latex/base/article.cls')).toBe(true);
    expect(globMatch('doc/**', 'doc/latex/base/manual.pdf')).toBe(true);
    expect(globMatch('tex/latex/base/**', 'tex/latex/base/sub/deep.sty')).toBe(true);
  });

  it('does not cross into sibling directories', () => {
    expect(globMatch('tex/latex/base/**', 'tex/latex/base-x/other.cls')).toBe(false);
    expect(globMatch('doc/**', 'docs/file')).toBe(false);
  });

  it('supports ** in the middle and * within a segment', () => {
    expect(globMatch('scripts/**/*.pl', 'scripts/foo/bar/tool.pl')).toBe(true);
    expect(globMatch('scripts/**/*.pl', 'scripts/tool.pl')).toBe(true);
    expect(globMatch('scripts/**/*.pl', 'scripts/foo/tool.py')).toBe(false);
    expect(globMatch('fonts/*.map', 'fonts/pdftex.map')).toBe(true);
    expect(globMatch('fonts/*.map', 'fonts/sub/pdftex.map')).toBe(false);
  });

  it('matches literal patterns exactly', () => {
    expect(globMatch('web2c/texmf.cnf', 'web2c/texmf.cnf')).toBe(true);
    expect(globMatch('web2c/texmf.cnf', 'web2c/texmf.cnf.bak')).toBe(false);
  });
});

describe('classify', () => {
  const core = ['tex/latex/base/**', 'web2c/**'];
  const strip = ['doc/**', 'tex/generic/babel-arabic/**'];

  it('core beats strip beats full', () => {
    expect(classify('tex/latex/base/article.cls', core, strip)).toBe('core');
    expect(classify('doc/latex/base/manual.pdf', core, strip)).toBe('cdn');
    expect(classify('tex/latex/geometry/geometry.sty', core, strip)).toBe('full');
  });
});

describe('inferPackage', () => {
  it('resolves common TDS layouts', () => {
    expect(inferPackage('tex/latex/geometry/geometry.sty')).toBe('geometry');
    expect(inferPackage('fonts/tfm/public/cm/cmr10.tfm')).toBe('cm');
    expect(inferPackage('bibtex/bst/natbib/plainnat.bst')).toBe('natbib');
    expect(inferPackage('web2c/texmf.cnf')).toBeNull();
  });
});
