import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createSynctex } from '../src/synctex';

const SYNCTEX_TEXT =
  'SyncTeX Version:1\n' +
  'Input:1:/project/main.tex\n' +
  'Input:2:/project/chapters/intro.tex\n' +
  'Output:pdf\n' +
  'Magnification:1000\n';

describe('createSynctex', () => {
  it('parses the gzip-compressed form engines actually emit (.synctex.gz)', async () => {
    const gz = new Uint8Array(gzipSync(Buffer.from(SYNCTEX_TEXT, 'utf8')));
    const lookup = await createSynctex(gz);
    expect(lookup.files().sort()).toEqual(['/project/chapters/intro.tex', '/project/main.tex']);
  });

  it('parses already-decompressed text identically', async () => {
    const lookup = await createSynctex(new TextEncoder().encode(SYNCTEX_TEXT));
    expect(lookup.files()).toHaveLength(2);
  });
});
