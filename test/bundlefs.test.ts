import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createBundleFs, detectFormat } from '../src/vfs/bundlefs';
import { buildTar } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it('fetches and unpacks a bundleUrl (the EngineConfig.bundleUrl path)', async () => {
    const tar = buildTar([{ path: 'texmf/tex/latex/base/size10.clo', content: 'CLO' }]);
    const gz = gzipSync(tar);
    const ab = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(ab) }),
    );
    const fs = await createBundleFs({
      bundleUrl: 'https://example.test/core/texmf.tar.gz',
      // A bundle fetched from another origin has to be pinned (see below).
      sha256: createHash('sha256').update(gz).digest('hex'),
    });
    await fs.init?.();
    expect(decode((await fs.read('tex/latex/base/size10.clo'))!)).toBe('CLO');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      'https://example.test/core/texmf.tar.gz',
    );
  });

  it('drops archive entries that escape the tree (tar slip)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tar = buildTar([
      { path: 'texmf/tex/latex/base/article.cls', content: 'GOOD' },
      { path: 'texmf/../../../etc/passwd', content: 'EVIL' },
      { path: '/etc/shadow', content: 'EVIL' },
    ]);
    const fs = await createBundleFs({ bundleBytes: tar });
    await fs.init?.();

    expect(decode((await fs.read('tex/latex/base/article.cls'))!)).toBe('GOOD');
    expect(await fs.list!('')).toEqual(['tex/latex/base/article.cls']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('escaping path'));
    warn.mockRestore();
  });

  it('rejects a bundle whose bytes do not match the expected digest', async () => {
    const tar = buildTar([{ path: 'texmf/a.tex', content: 'A' }]);
    const ab = tar.buffer.slice(tar.byteOffset, tar.byteOffset + tar.byteLength);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(ab) }),
    );
    const fs = await createBundleFs({
      bundleUrl: 'https://example.test/core/texmf.tar',
      sha256: 'f'.repeat(64), // not the digest of anything we built
    });
    await expect(fs.init!()).rejects.toThrow(/integrity check failed/);
  });

  it('accepts a bundle whose bytes match the expected digest', async () => {
    const tar = buildTar([{ path: 'texmf/a.tex', content: 'A' }]);
    const ab = tar.buffer.slice(tar.byteOffset, tar.byteOffset + tar.byteLength);
    const sha = createHash('sha256').update(Buffer.from(tar)).digest('hex');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(ab) }),
    );
    const fs = await createBundleFs({
      bundleUrl: 'https://example.test/core/texmf.tar',
      sha256: sha,
    });
    await fs.init?.();
    expect(decode((await fs.read('a.tex'))!)).toBe('A');
  });

  it('refuses a cross-origin bundle that no digest pins', async () => {
    // The bundle is the whole tree the engine executes; unpinned bytes from
    // someone else's origin are arbitrary TeX.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const fs = await createBundleFs({ bundleUrl: 'https://cdn.example.test/core/texmf.tar.gz' });
    await expect(fs.init!()).rejects.toThrow(/no SHA-256/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows an unpinned bundle when the caller opts out for development', async () => {
    const tar = buildTar([{ path: 'texmf/a.tex', content: 'A' }]);
    const ab = tar.buffer.slice(tar.byteOffset, tar.byteOffset + tar.byteLength);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(ab) }),
    );
    const fs = await createBundleFs({
      bundleUrl: 'https://cdn.example.test/core/texmf.tar',
      allowUnverified: true,
    });
    await fs.init?.();
    expect(decode((await fs.read('a.tex'))!)).toBe('A');
  });

  it('drops a duplicate entry rather than letting the last copy win', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tar = buildTar([
      { path: 'texmf/tex/latex/base/article.cls', content: 'REAL' },
      { path: 'texmf/tex/latex/base/article.cls', content: 'SHADOW' },
    ]);
    const fs = await createBundleFs({ bundleBytes: tar });
    await fs.init?.();

    expect(decode((await fs.read('tex/latex/base/article.cls'))!)).toBe('REAL');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate archive entr'));
    warn.mockRestore();
  });

  it('refuses a bundle whose compression it cannot identify', async () => {
    // The old code fed anything unrecognized to DecompressionStream('br') —
    // including an HTML error page a proxy substituted for the bundle.
    const html = new TextEncoder().encode('<!doctype html><title>502 Bad Gateway</title>');
    const fs = await createBundleFs({ bundleBytes: html });
    await expect(fs.init!()).rejects.toThrow(/cannot tell what/);
  });

  it('refuses a download past the compressed-size ceiling', async () => {
    const tar = buildTar([{ path: 'texmf/a.tex', content: 'A' }]);
    const ab = tar.buffer.slice(tar.byteOffset, tar.byteOffset + tar.byteLength);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(ab) }),
    );
    const fs = await createBundleFs({
      bundleUrl: 'https://cdn.example.test/core/texmf.tar',
      allowUnverified: true,
      maxCompressedBytes: 16,
    });
    await expect(fs.init!()).rejects.toThrow(/download limit/);
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

  it('ignores a query string when reading the suffix', () => {
    expect(detectFormat('https://x/y.tar.gz?v=3', new Uint8Array())).toBe('gzip');
  });

  it('refuses to guess brotli: it has no magic bytes, so it must be asserted', () => {
    // Anything unrecognized used to be handed to DecompressionStream('br').
    expect(detectFormat(undefined, new Uint8Array([0x1b, 0x5a, 0x00, 0xff]))).toBeNull();
    expect(detectFormat('https://x/y.tar.br', new Uint8Array([0x1b, 0x5a]))).toBe('br');
  });
});
