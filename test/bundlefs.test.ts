import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createBundleFs, detectFormat } from '../src/vfs/bundlefs';
import { buildTar } from './helpers';

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe('createBundleFs', () => {
  it('serves files from raw tar bundleBytes with the default texmf/ prefix stripped', async () => {
    const tar = buildTar([
      { path: 'texmf/tex/latex/base/article.cls', content: 'class body' },
      { path: 'texmf/web2c/pdftex/pdflatex.fmt', content: 'FMT' },
    ]);
    const fs = await createBundleFs({ bundleBytes: tar });
    await fs.init?.();
    expect(decode((await fs.read('tex/latex/base/article.cls'))!)).toBe('class body');
    expect(await fs.read('/tex/latex/base/article.cls')).not.toBeNull(); // leading slash ok
    expect(await fs.read('tex/latex/base/missing.sty')).toBeNull();
    expect(await fs.exists!('web2c/pdftex/pdflatex.fmt')).toBe(true);
    expect(await fs.list!('tex/')).toEqual(['tex/latex/base/article.cls']);
  });

  it('auto-detects gzip bundleBytes by magic bytes', async () => {
    const tar = buildTar([{ path: 'texmf/a.tex', content: 'A' }]);
    const gz = new Uint8Array(gzipSync(tar));
    const fs = await createBundleFs({ bundleBytes: gz });
    await fs.init?.();
    expect(decode((await fs.read('a.tex'))!)).toBe('A');
  });
});

describe('detectFormat', () => {
  const tarBytes = buildTar([{ path: 'texmf/a', content: 'x' }]);

  it('detects by URL suffix first', () => {
    expect(detectFormat('https://x/y.tar.gz', new Uint8Array())).toBe('gzip');
    expect(detectFormat('https://x/y.tgz', new Uint8Array())).toBe('gzip');
    expect(detectFormat('https://x/y.tar.br', new Uint8Array())).toBe('br');
    expect(detectFormat('https://x/y.tar', new Uint8Array())).toBe('raw');
  });

  it('sniffs gzip magic bytes', () => {
    expect(detectFormat(undefined, new Uint8Array(gzipSync(Buffer.from(tarBytes))))).toBe('gzip');
  });

  it('sniffs plain tar via the ustar magic at offset 257', () => {
    expect(detectFormat(undefined, tarBytes)).toBe('raw');
  });

  it('falls back to brotli for anything else (brotli has no magic bytes)', () => {
    expect(detectFormat(undefined, new Uint8Array([0x1b, 0x5a, 0x00, 0xff]))).toBe('br');
  });
});
