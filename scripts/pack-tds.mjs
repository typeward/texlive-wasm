#!/usr/bin/env node
/**
 * pack-tds.mjs — pack engine-artifacts/texmf/ into compressed tarballs for
 * runtime download + decompression.
 *
 * Output:
 *   engine-artifacts/texmf.tar.gz   gzip-9 (~28 MB; universal browser support)
 *   engine-artifacts/texmf.tar.br   brotli-11 (~18 MB; Chrome 121+/FF 127+)
 *
 * Usage:
 *   node scripts/pack-tds.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants as zlibC } from 'node:zlib';
import { join } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const TEXMF = join(REPO_ROOT, 'engine-artifacts/texmf');
const TAR = join(REPO_ROOT, 'engine-artifacts/texmf.tar');
const TAR_GZ = join(REPO_ROOT, 'engine-artifacts/texmf.tar.gz');
const TAR_BR = join(REPO_ROOT, 'engine-artifacts/texmf.tar.br');

try {
  statSync(TEXMF);
} catch {
  console.error(`texmf not found at ${TEXMF}. Run scripts/fetch-tds.sh first.`);
  process.exit(1);
}

console.error('[pack-tds] creating tar archive (reproducible)...');
execSync(
  `tar -c --sort=name --owner=0 --group=0 --numeric-owner -f "${TAR}" -C "${join(REPO_ROOT, 'engine-artifacts')}" texmf/`,
  { stdio: 'inherit' },
);

const tar = readFileSync(TAR);
console.error(`[pack-tds] tar: ${(tar.length / 1024 / 1024).toFixed(1)} MB`);

console.error('[pack-tds] gzip-9...');
const gz = gzipSync(tar, { level: 9 });
writeFileSync(TAR_GZ, gz);
console.error(`[pack-tds]   → ${(gz.length / 1024 / 1024).toFixed(1)} MB`);

console.error('[pack-tds] brotli-11 (slow, ~60s)...');
const br = brotliCompressSync(tar, {
  params: {
    [zlibC.BROTLI_PARAM_QUALITY]: 11,
    [zlibC.BROTLI_PARAM_LGWIN]: 24,
  },
});
writeFileSync(TAR_BR, br);
console.error(`[pack-tds]   → ${(br.length / 1024 / 1024).toFixed(1)} MB`);

unlinkSync(TAR);
console.error('[pack-tds] done');
