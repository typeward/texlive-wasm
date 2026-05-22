#!/usr/bin/env node
/**
 * smoke-xelatex.mjs — end-to-end test: xelatex → .xdv → (xdvipdfmx) → .pdf
 *
 * 1. Load xelatex.wasm, run `xetex hello.tex` → produces hello.xdv
 * 2. Load xdvipdfmx.wasm, run `xdvipdfmx hello.xdv` → produces hello.pdf
 * 3. Write hello-from-wasm-xelatex.pdf to disk
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const TEXMF = join(REPO_ROOT, 'engine-artifacts/texmf');
const ICU_DATA = join(REPO_ROOT, 'engine-artifacts/icudt78l.dat');

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

async function instantiateEngine(engineName, withICU) {
  const mod = await import(join(REPO_ROOT, `engine-artifacts/${engineName}/emscripten/${engineName}.js`));
  const M = await mod.default({
    noInitialRun: true,
    thisProgram: `/bin/${engineName}`,
    print: (t) => process.stdout.write(t + '\n'),
    printErr: (t) => process.stderr.write(t + '\n'),
  });
  if (withICU) {
    const icu = readFileSync(ICU_DATA);
    const ptr = M._malloc(icu.length);
    M.HEAPU8.set(icu, ptr);
    const errPtr = M._malloc(4);
    M.HEAPU32[errPtr >> 2] = 0;
    M._udata_setCommonData_78(ptr, errPtr);
  }
  walk(M.FS, TEXMF, '/texmf-dist');
  M.FS.mkdir('/bin');
  M.FS.writeFile(`/bin/${engineName}`, new Uint8Array());
  M.FS.mkdir('/project');
  M.FS.chdir('/project');
  return M;
}

const TEX_SOURCE = `\\documentclass{article}
\\begin{document}
Hello from xelatex on WASM.
\\end{document}
`;

console.log('=== STEP 1: xelatex hello.tex → hello.xdv ===');
const xetex = await instantiateEngine('xelatex', true);
xetex.FS.writeFile('/project/hello.tex', TEX_SOURCE);

const T = '/texmf-dist';
let xetexCode;
try {
  xetexCode = xetex.callMain([
    '-interaction=nonstopmode',
    '-no-pdf',  // produce .xdv
    `-fmt=${T}/web2c/xetex/xelatex.fmt`,
    `-cnf-line=TEXMFCNF=${T}/web2c`,
    `-cnf-line=TEXMF=${T}`,
    `-cnf-line=TEXMFDIST=${T}`,
    `-cnf-line=TEXINPUTS=.;${T}/tex//`,
    `-cnf-line=TFMFONTS=${T}/fonts/tfm//`,
    `-cnf-line=OPENTYPEFONTS=${T}/fonts/opentype//;${T}/fonts/truetype//;${T}/fonts/type1//`,
    `-cnf-line=OPENTYPEFONTS.xetex=${T}/fonts/opentype//;${T}/fonts/truetype//;${T}/fonts/type1//`,
    `-cnf-line=TRUETYPEFONTS=${T}/fonts/truetype//`,
    'hello.tex',
  ]);
} catch (e) {
  xetexCode = e?.status ?? -1;
}
console.log(`xetex exit=${xetexCode}`);

if (!xetex.FS.analyzePath('/project/hello.xdv').exists) {
  console.error('NO xdv produced');
  if (xetex.FS.analyzePath('/project/hello.log').exists) {
    console.error(new TextDecoder().decode(xetex.FS.readFile('/project/hello.log')).slice(-2000));
  }
  process.exit(1);
}
const xdv = xetex.FS.readFile('/project/hello.xdv');
console.log(`hello.xdv: ${xdv.length} bytes`);

console.log('\n=== STEP 2: xdvipdfmx hello.xdv → hello.pdf ===');
const dvi = await instantiateEngine('xdvipdfmx', false);
dvi.FS.writeFile('/project/hello.xdv', xdv);

// xdvipdfmx doesn't honor -cnf-line; need a config file at expected location.
// Write a minimal dvipdfmx.cfg to /project (current dir, gets checked first).
dvi.FS.writeFile('/project/dvipdfmx.cfg', '');
let dviCode;
try {
  dviCode = dvi.callMain([
    '-o', 'hello.pdf',
    'hello.xdv',
  ]);
} catch (e) {
  dviCode = e?.status ?? -1;
}
console.log(`xdvipdfmx exit=${dviCode}`);

if (dvi.FS.analyzePath('/project/hello.pdf').exists) {
  const pdf = dvi.FS.readFile('/project/hello.pdf');
  writeFileSync(join(REPO_ROOT, 'hello-from-wasm-xelatex.pdf'), pdf);
  console.log(`✓ PDF: ${pdf.length} bytes → hello-from-wasm-xelatex.pdf`);
}
