import { describe, expect, it } from 'vitest';
import { buildLsR } from '../src/core/lsr';

describe('buildLsR', () => {
  it('renders per-directory blocks with files and subdirs', () => {
    const db = buildLsR([
      'tex/latex/base/article.cls',
      'tex/latex/amsmath/amsmath.sty',
      'web2c/texmf.cnf',
    ]);
    expect(db.startsWith('% ls-R -- filename database for kpathsea')).toBe(true);
    // Root block lists top-level dirs.
    expect(db).toContain('\n./:\ntex\nweb2c\n');
    // Intermediate dirs list their children.
    expect(db).toContain('\n./tex/latex:\namsmath\nbase\n');
    // Leaf dirs list files.
    expect(db).toContain('\n./tex/latex/base:\narticle.cls\n');
    expect(db).toContain('\n./web2c:\ntexmf.cnf\n');
  });

  it('does not index a bundled ls-R file itself', () => {
    const db = buildLsR(['ls-R', 'tex/a.sty']);
    expect(db).not.toContain('\nls-R\n');
  });

  it('deduplicates shared parents', () => {
    const db = buildLsR(['fonts/tfm/a.tfm', 'fonts/tfm/b.tfm']);
    const rootBlocks = db.match(/\.\/fonts:/g);
    expect(rootBlocks).toHaveLength(1);
    expect(db).toContain('\n./fonts/tfm:\na.tfm\nb.tfm\n');
  });
});
