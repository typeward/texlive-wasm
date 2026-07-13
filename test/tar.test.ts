import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { untar, decompress } from '../src/vfs/tar';
import { buildTar, paxBody } from './helpers';

const text = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe('untar', () => {
  it('parses a simple file entry', () => {
    const tar = buildTar([{ path: 'tex/latex/base/article.cls', content: 'hello' }]);
    const entries = untar(tar);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('tex/latex/base/article.cls');
    expect(entries[0]!.type).toBe('file');
    expect(decode(entries[0]!.content)).toBe('hello');
  });

  it('rounds content to 512-byte blocks without corrupting following entries', () => {
    const tar = buildTar([
      { path: 'a.txt', content: 'x'.repeat(513) }, // spills into a second block
      { path: 'b.txt', content: 'second' },
    ]);
    const entries = untar(tar);
    expect(entries.map((e) => e.path)).toEqual(['a.txt', 'b.txt']);
    expect(entries[0]!.content.length).toBe(513);
    expect(decode(entries[1]!.content)).toBe('second');
  });

  it('joins ustar prefix and name for long paths', () => {
    const longPath =
      'texmf/fonts/opentype/public/some-extremely-long-font-family-name-directory/' +
      'a-really-long-font-file-name-that-overflows-the-name-field-0123456789.otf';
    const tar = buildTar([{ path: longPath, content: 'font' }]);
    const entries = untar(tar);
    expect(entries[0]!.path).toBe(longPath);
  });

  it('handles GNU L long-name entries', () => {
    const longName = 'dir/' + 'n'.repeat(180) + '.sty';
    const tar = buildTar([
      { path: '././@LongLink', content: longName + '\0', type: 'gnu-long-name' },
      { path: 'dir/truncated.sty', content: 'body' },
    ]);
    const entries = untar(tar);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe(longName);
    expect(decode(entries[0]!.content)).toBe('body');
  });

  it('applies the path override from a PAX extended header', () => {
    const paxPath = 'tex/latex/pax-named/real-name.sty';
    const tar = buildTar([
      { path: 'PaxHeaders/x', content: paxBody({ path: paxPath }), type: 'pax' },
      { path: 'tex/latex/pax-named/truncated', content: 'pax body' },
    ]);
    const entries = untar(tar);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe(paxPath);
    expect(decode(entries[0]!.content)).toBe('pax body');
  });

  it('marks directories and stops at the zero end blocks', () => {
    const tar = buildTar([
      { path: 'texmf/', type: 'dir' },
      { path: 'texmf/file.tex', content: 'ok' },
    ]);
    const entries = untar(tar);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.type).toBe('dir');
    expect(entries[0]!.content.length).toBe(0);
    expect(entries[1]!.type).toBe('file');
  });

  it('classifies links and devices as "other" so no caller can mistake them for files', () => {
    const tar = buildTar([
      { path: 'texmf/link.sty', type: 'symlink' },
      { path: 'texmf/hard.sty', type: 'hardlink' },
      { path: 'texmf/tty', type: 'chardev' },
      { path: 'texmf/real.sty', content: 'REAL' },
    ]);
    const entries = untar(tar);
    expect(entries.filter((e) => e.type === 'file').map((e) => e.path)).toEqual(['texmf/real.sty']);
    expect(entries.filter((e) => e.type === 'other')).toHaveLength(3);
  });

  it('rejects a header whose size runs past the end of the archive', () => {
    // A truncated download, or a header lying about its payload: subarray()
    // would hand back a short read and the engine would compile with half a
    // file rather than fail.
    const tar = buildTar([{ path: 'a.tex', content: 'short', declaredSize: 1024 * 1024 }]);
    expect(() => untar(tar)).toThrow(/past the end of the archive/);
  });

  it('rejects a truncated archive', () => {
    const full = buildTar([{ path: 'a.tex', content: 'x'.repeat(2000) }]);
    expect(() => untar(full.subarray(0, 1024))).toThrow(/past the end of the archive/);
  });

  it('rejects an archive with more entries than the ceiling allows', () => {
    const specs = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.tex`, content: 'x' }));
    expect(() => untar(buildTar(specs), { maxEntries: 10 })).toThrow(/more than 10 entries/);
    expect(untar(buildTar(specs), { maxEntries: 12 })).toHaveLength(12);
  });

  it('survives garbage without hanging or reading out of bounds', () => {
    // Fuzz-ish: random bytes in tar-shaped blocks. Every outcome is
    // acceptable except a hang, an out-of-bounds read, or a silent short read.
    let rng = 0x2f6e2b1;
    const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) >>> 8) & 0xff;
    for (let i = 0; i < 200; i++) {
      const bytes = new Uint8Array(512 * (1 + (rand() % 4)));
      for (let j = 0; j < bytes.length; j++) bytes[j] = rand();
      let entries: ReturnType<typeof untar> | null = null;
      try {
        entries = untar(bytes);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        continue;
      }
      for (const entry of entries) {
        // Whatever we chose to report, the content must be inside the buffer.
        expect(entry.content.byteOffset + entry.content.byteLength).toBeLessThanOrEqual(
          bytes.byteLength,
        );
      }
    }
  });
});

describe('decompress', () => {
  it('round-trips gzip via DecompressionStream', async () => {
    const original = text('gzip round trip payload');
    const compressed = new Uint8Array(gzipSync(original));
    const out = await decompress(compressed, 'gzip');
    expect(decode(out)).toBe('gzip round trip payload');
  });

  it('refuses a stream that expands past the ceiling', async () => {
    // 8 MB of zeroes gzips to a few KB — a compression bomb in miniature.
    const bomb = new Uint8Array(gzipSync(new Uint8Array(8 * 1024 * 1024)));
    await expect(decompress(bomb, 'gzip', 1024 * 1024)).rejects.toThrow(/expands past/);
    // The same bytes are fine when the ceiling accommodates them.
    const out = await decompress(bomb, 'gzip', 16 * 1024 * 1024);
    expect(out.length).toBe(8 * 1024 * 1024);
  });
});
