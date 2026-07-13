import { describe, expect, it } from 'vitest';
import { safeRelativePath, safeResolve } from '../src/core/paths';

describe('safeRelativePath', () => {
  it('normalizes a path to a root-relative one', () => {
    expect(safeRelativePath('tex/latex/base/article.cls')).toBe('tex/latex/base/article.cls');
    expect(safeRelativePath('/tex//latex/./base/article.cls')).toBe('tex/latex/base/article.cls');
  });

  it('rejects anything that climbs out of the root', () => {
    expect(safeRelativePath('../etc/passwd')).toBeNull();
    expect(safeRelativePath('tex/../../etc/passwd')).toBeNull();
    expect(safeRelativePath('/../texmf-dist/web2c/pdftex/pdflatex.fmt')).toBeNull();
    // A tar entry may use backslashes; they must not slip a `..` past us.
    expect(safeRelativePath('..\\..\\etc\\passwd')).toBeNull();
    expect(safeRelativePath('C:/Windows/system32')).toBeNull();
  });

  it('rejects an empty path', () => {
    expect(safeRelativePath('')).toBeNull();
    expect(safeRelativePath('/')).toBeNull();
    expect(safeRelativePath('.')).toBeNull();
  });

  it('rejects a NUL byte, which would truncate the path at the C boundary', () => {
    expect(safeRelativePath('main.tex\0../../etc/passwd')).toBeNull();
  });

  it('never returns a path that escapes when fed hostile shapes', () => {
    const hostile = [
      '..',
      '../',
      './../',
      'a/../../b',
      '//../etc',
      '\\..\\..\\etc',
      'a/./../../..',
      '....//....//etc',
      '/..',
      'C:\\Windows',
      'c:/windows',
    ];
    for (const path of hostile) {
      const safe = safeRelativePath(path);
      if (safe === null) continue;
      // "....//....//etc" is not an escape — it is a directory literally named
      // "....". Whatever survives must contain no traversal segment at all.
      expect(safe.split('/')).not.toContain('..');
      expect(safe.startsWith('/')).toBe(false);
    }
  });
});

describe('safeResolve', () => {
  it('resolves under the root', () => {
    expect(safeResolve('/project', 'main.tex')).toBe('/project/main.tex');
    expect(safeResolve('/project', '/project/sub/main.tex')).toBe('/project/sub/main.tex');
    expect(safeResolve('/project', '/project')).toBe('/project');
    expect(safeResolve('/project', '/project/')).toBe('/project');
  });

  it('refuses to leave the root', () => {
    expect(safeResolve('/project', '/texmf-dist')).toBeNull();
    expect(safeResolve('/project', '/project/../texmf-dist')).toBeNull();
    expect(safeResolve('/project', '/')).toBeNull();
    // A sibling that merely shares the root's prefix is not inside it.
    expect(safeResolve('/project', '/projectile/main.tex')).toBeNull();
  });
});
