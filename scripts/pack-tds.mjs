#!/usr/bin/env node
/**
 * pack-tds.mjs — pack engine-artifacts/texmf/ into compressed tarballs for
 * runtime download + decompression.
 *
 * Output:
 *   engine-artifacts/texmf.tar.gz   gzip-9 (~28 MB; universal browser support)
 *   engine-artifacts/texmf.tar.br   brotli-11 (~18 MB; Chrome 121+/FF 127+)
 *
 * The tar is written by a minimal pure-JS USTAR writer (sorted entries,
 * zeroed mtime/uid/gid) so the bytes are reproducible and the script runs
 * identically on Linux, macOS and Windows — no GNU tar required.
 *
 * Usage:
 *   node scripts/pack-tds.mjs
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants as zlibC } from 'node:zlib';
import { join, relative } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACTS = join(REPO_ROOT, 'engine-artifacts');
const TEXMF = join(ARTIFACTS, 'texmf');
const TAR_GZ = join(ARTIFACTS, 'texmf.tar.gz');
const TAR_BR = join(ARTIFACTS, 'texmf.tar.br');

try {
  statSync(TEXMF);
} catch {
  console.error(`texmf not found at ${TEXMF}. Run scripts/fetch-tds.sh first.`);
  process.exit(1);
}

console.error('[pack-tds] creating tar archive (reproducible, pure JS)...');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (st.isFile()) files.push(full);
  }
})(TEXMF);

const chunks = [];
for (const abs of files) {
  const rel = 'texmf/' + relative(TEXMF, abs).replaceAll('\\', '/');
  const data = readFileSync(abs);
  chunks.push(ustarHeader(rel, data.length), data);
  const pad = (512 - (data.length % 512)) % 512;
  if (pad) chunks.push(Buffer.alloc(pad));
}
chunks.push(Buffer.alloc(1024)); // two empty 512-byte end blocks
const tar = Buffer.concat(chunks);
console.error(`[pack-tds] tar: ${(tar.length / 1024 / 1024).toFixed(1)} MB (${files.length} files)`);

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

console.error('[pack-tds] done');

function ustarHeader(path, size) {
  const buf = Buffer.alloc(512);
  const { prefix, name } = splitUstarPath(path);
  buf.write(name, 0, 100);
  writeOctal(buf, 100, 8, 0o644); // mode
  writeOctal(buf, 108, 8, 0); // uid
  writeOctal(buf, 116, 8, 0); // gid
  writeOctal(buf, 124, 12, size); // size
  writeOctal(buf, 136, 12, 0); // mtime — zero for reproducible bytes
  buf.fill(0x20, 148, 156); // checksum placeholder (spaces)
  buf[156] = 0x30; // typeflag '0' regular file
  buf.write('ustar\0', 257, 6); // magic
  buf.write('00', 263, 2); // version
  if (prefix) buf.write(prefix, 345, 155);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  writeOctal(buf, 148, 7, sum);
  buf[155] = 0x20;
  return buf;
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { prefix: '', name: path };
  // Split on the last '/' that leaves name ≤ 100 and prefix ≤ 155.
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i] !== '/') continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { prefix, name };
    }
  }
  throw new Error(`pack-tds: path too long for USTAR (${path})`);
}

function writeOctal(buf, offset, len, value) {
  const str = value.toString(8).padStart(len - 1, '0');
  buf.write(str + '\0', offset, len);
}
