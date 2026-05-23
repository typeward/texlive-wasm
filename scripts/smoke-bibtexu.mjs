#!/usr/bin/env node
/**
 * smoke-bibtexu.mjs — exercise the bibtexu engine: write a .aux + .bib +
 * .bst, invoke bibtexu, verify it produces a non-empty .bbl.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const TEXMF = join(REPO, 'engine-artifacts/texmf');
const ICU_DATA = join(REPO, 'engine-artifacts/icudt78l.dat');

function walk(FS, abs, mfs) {
  if (!FS.analyzePath(mfs).exists) FS.mkdir(mfs);
  for (const n of readdirSync(abs)) {
    const a = join(abs, n);
    const m = mfs + '/' + n;
    let s; try { s = statSync(a); } catch { continue; }
    if (s.isDirectory()) walk(FS, a, m);
    else if (s.isFile()) { try { FS.writeFile(m, readFileSync(a)); } catch {} }
  }
}

const AUX = `\\bibstyle{plain}
\\citation{KnuthArt}
\\bibdata{refs}
`;
const BIB = `@book{KnuthArt,
  author = {Donald E. Knuth},
  title  = {The Art of Computer Programming},
  publisher = {Addison-Wesley},
  year   = {1968},
}
`;

const mod = await import(join(REPO, 'engine-artifacts/bibtexu/emscripten/bibtexu.js'));
const M = await mod.default({
  noInitialRun: true,
  thisProgram: '/bin/bibtexu',
  print: (t) => process.stdout.write(t + '\n'),
  printErr: (t) => process.stderr.write(t + '\n'),
});

// Load ICU data for bibtexu (it links libicu).
if (M._udata_setCommonData_78) {
  const icu = readFileSync(ICU_DATA);
  const ptr = M._malloc(icu.length);
  M.HEAPU8.set(icu, ptr);
  const errPtr = M._malloc(4);
  M.HEAPU32[errPtr >> 2] = 0;
  M._udata_setCommonData_78(ptr, errPtr);
  const err = M.HEAPU32[errPtr >> 2];
  console.log(`[smoke-bibtexu] _udata_setCommonData_78 errorCode=${err} (0=ok)`);
}

walk(M.FS, TEXMF, '/texmf-dist');
M.FS.mkdir('/bin');
M.FS.writeFile('/bin/bibtexu', new Uint8Array());
M.FS.mkdir('/project');
M.FS.chdir('/project');
M.FS.writeFile('/project/refs.aux', AUX);
M.FS.writeFile('/project/refs.bib', BIB);

let code;
try {
  code = M.callMain(['-l', 'en', 'refs']);
} catch (e) { code = e?.status ?? -1; }
console.log(`bibtexu exit=${code}`);

if (!M.FS.analyzePath('/project/refs.bbl').exists) {
  console.error('✗ no .bbl produced');
  if (M.FS.analyzePath('/project/refs.blg').exists) {
    console.error(new TextDecoder().decode(M.FS.readFile('/project/refs.blg')).slice(-1500));
  }
  process.exit(1);
}

const bbl = M.FS.readFile('/project/refs.bbl');
const text = new TextDecoder().decode(bbl);
if (!text.includes('Knuth')) {
  console.error('✗ .bbl does not include "Knuth":', text.slice(0, 500));
  process.exit(1);
}
writeFileSync(join(REPO, 'refs-from-wasm.bbl'), bbl);
console.log(`✓ .bbl: ${bbl.length} bytes → refs-from-wasm.bbl (contains "Knuth")`);
