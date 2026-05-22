#!/usr/bin/env node
/**
 * build-fmt.mjs — generate pdflatex.fmt with our wasm pdflatex.
 *
 * Run AFTER `bash scripts/fetch-tds.sh` populates the TDS.
 *
 * Output: engine-artifacts/texmf/web2c/pdftex/pdflatex.fmt
 *
 * Why: the .fmt file is tightly coupled to the executable that built it
 * (string-pool offsets etc.). Ubuntu's apt-shipped .fmt is for Ubuntu's
 * pdflatex; ours rejects it with "made by different executable version".
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const TEXMF = join(REPO_ROOT, 'engine-artifacts/texmf');
const PDFLATEX_JS = join(REPO_ROOT, 'engine-artifacts/pdflatex/emscripten/pdflatex.js');

if (!statSync(TEXMF, { throwIfNoEntry: false })) {
  console.error('Run scripts/fetch-tds.sh first to populate', TEXMF);
  process.exit(1);
}

const m = await import(PDFLATEX_JS);

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
  thisProgram: '/bin/pdflatex',
  print: (t) => process.stdout.write(t + '\n'),
  printErr: (t) => process.stderr.write(t + '\n'),
});

walk(Module.FS, TEXMF, '/texmf-dist');
Module.FS.mkdir('/bin');
Module.FS.writeFile('/bin/pdflatex', new Uint8Array());
Module.FS.mkdir('/work');
Module.FS.chdir('/work');

console.error('[build-fmt] building pdflatex.fmt with wasm pdflatex...');
const t0 = Date.now();
let exitCode;
try {
  exitCode = Module.callMain([
    '-ini', '-etex',
    '-interaction=nonstopmode',
    '-jobname=pdflatex',
    '-output-format=dvi',
    '-cnf-line=TEXMFCNF=/texmf-dist/web2c',
    '-cnf-line=TEXMF=/texmf-dist',
    '-cnf-line=TEXMFDIST=/texmf-dist',
    '-cnf-line=TEXINPUTS=.;/texmf-dist/tex//',
    '-cnf-line=TFMFONTS=/texmf-dist/fonts/tfm//',
    '/texmf-dist/tex/latex/tex-ini-files/pdflatex.ini',
  ]);
} catch (e) {
  exitCode = e?.status ?? -1;
}
console.error(`[build-fmt] exit=${exitCode} in ${Date.now() - t0}ms`);

if (!Module.FS.analyzePath('/work/pdflatex.fmt').exists) {
  console.error('[build-fmt] FAILED — no fmt produced');
  if (Module.FS.analyzePath('/work/pdflatex.log').exists) {
    console.error(new TextDecoder().decode(Module.FS.readFile('/work/pdflatex.log')).slice(-2000));
  }
  process.exit(1);
}

const fmt = Module.FS.readFile('/work/pdflatex.fmt');
const outPath = join(TEXMF, 'web2c/pdftex/pdflatex.fmt');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, fmt);
console.error(`[build-fmt] wrote ${outPath} (${fmt.length} bytes)`);
