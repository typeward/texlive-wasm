#!/usr/bin/env node
/**
 * build-xelatex-fmt.mjs — build xelatex.fmt using our wasm xetex.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEXMF = join(REPO_ROOT, 'engine-artifacts/texmf');
const XELATEX_JS = join(REPO_ROOT, 'engine-artifacts/xelatex/emscripten/xelatex.js');
const ICU_DATA = join(REPO_ROOT, 'engine-artifacts/icudt78l.dat');

const m = await import(XELATEX_JS);

function walk(FS, absDir, mfsDir) {
  if (!FS.analyzePath(mfsDir).exists) FS.mkdir(mfsDir);
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name);
    const mfs = mfsDir + '/' + name;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(FS, abs, mfs);
    else if (st.isFile()) {
      try { FS.writeFile(mfs, readFileSync(abs)); } catch {}
    }
  }
}

const Module = await m.default({
  noInitialRun: true,
  thisProgram: '/bin/xelatex',
  print: (t) => process.stdout.write(t + '\n'),
  printErr: (t) => process.stderr.write(t + '\n'),
});

// Load ICU data first.
const icuData = readFileSync(ICU_DATA);
const icuPtr = Module._malloc(icuData.length);
Module.HEAPU8.set(icuData, icuPtr);
const errPtr = Module._malloc(4);
Module.HEAPU32[errPtr >> 2] = 0;
Module._udata_setCommonData_78(icuPtr, errPtr);
console.error(`[build-xelatex-fmt] ICU data loaded, err=${Module.HEAPU32[errPtr >> 2]}`);

walk(Module.FS, TEXMF, '/texmf-dist');
Module.FS.mkdir('/bin');
Module.FS.writeFile('/bin/xelatex', new Uint8Array());
Module.FS.mkdir('/work');
Module.FS.chdir('/work');

console.error('[build-xelatex-fmt] building xelatex.fmt...');
const t0 = Date.now();
let exitCode;
try {
  exitCode = Module.callMain([
    '-ini', '-etex',
    '-interaction=nonstopmode',
    '-jobname=xelatex',
    '-cnf-line=TEXMFCNF=/texmf-dist/web2c',
    '-cnf-line=TEXMF=/texmf-dist',
    '-cnf-line=TEXMFDIST=/texmf-dist',
    '-cnf-line=TEXINPUTS=.;/texmf-dist/tex//',
    '-cnf-line=TFMFONTS=/texmf-dist/fonts/tfm//',
    '-cnf-line=OPENTYPEFONTS=/texmf-dist/fonts/opentype//',
    '/texmf-dist/tex/latex/tex-ini-files/xelatex.ini',
  ]);
} catch (e) {
  exitCode = e?.status ?? -1;
}
console.error(`[build-xelatex-fmt] exit=${exitCode} in ${Date.now() - t0}ms`);

if (!Module.FS.analyzePath('/work/xelatex.fmt').exists) {
  console.error('[build-xelatex-fmt] FAILED');
  if (Module.FS.analyzePath('/work/xelatex.log').exists) {
    console.error(new TextDecoder().decode(Module.FS.readFile('/work/xelatex.log')).slice(-2000));
  }
  process.exit(1);
}

const fmt = Module.FS.readFile('/work/xelatex.fmt');
const outPath = join(TEXMF, 'web2c/xetex/xelatex.fmt');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, fmt);
console.error(`[build-xelatex-fmt] wrote ${outPath} (${fmt.length} bytes)`);
