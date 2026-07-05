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
});

describe('decompress', () => {
  it('round-trips gzip via DecompressionStream', async () => {
    const original = text('gzip round trip payload');
    const compressed = new Uint8Array(gzipSync(original));
    const out = await decompress(compressed, 'gzip');
    expect(decode(out)).toBe('gzip round trip payload');
  });
});
