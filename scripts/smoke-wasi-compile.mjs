#!/usr/bin/env node
/**
 * smoke-wasi-compile.mjs — real end-to-end LaTeX compile through the
 * WASI build of pdflatex. The TDS and project dir are surfaced to WASI
 * via the preopens map; kpathsea reads them through normal file I/O.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WASI } from 'node:wasi';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const WASM = join(REPO, 'engine/build/pdflatex/wasi/pdflatex.wasm');
const TEXMF = join(REPO, 'engine-artifacts/texmf');

const workdir = join(tmpdir(), `tlwasm-wasi-${process.pid}`);
const bindir = join(tmpdir(), `tlwasm-wasi-bin-${process.pid}`);
rmSync(workdir, { recursive: true, force: true });
rmSync(bindir, { recursive: true, force: true });
mkdirSync(workdir, { recursive: true });
mkdirSync(bindir, { recursive: true });
writeFileSync(join(bindir, 'pdflatex'), '');

const source = `\\documentclass{article}
\\begin{document}
Hello from \\TeX{}Live 2026 WASI!
\\end{document}
`;
writeFileSync(join(workdir, 'hello.tex'), source);

console.log(`[smoke-wasi-compile] workdir: ${workdir}`);
console.log(`[smoke-wasi-compile] TDS:     ${TEXMF}`);

const T = '/texmf-dist';
const wasi = new WASI({
  version: 'preview1',
  args: [
    '/bin/pdflatex',
    '-interaction=nonstopmode',
    `-fmt=${T}/web2c/pdftex/pdflatex.fmt`,
    `-cnf-line=TEXMFCNF=${T}/web2c`,
    `-cnf-line=TEXMF=${T}`,
    `-cnf-line=TEXMFDIST=${T}`,
    `-cnf-line=TEXINPUTS=.;${T}/tex//`,
    `-cnf-line=TFMFONTS=${T}/fonts/tfm//`,
    `-cnf-line=VFFONTS=${T}/fonts/vf//`,
    `-cnf-line=T1FONTS=${T}/fonts/type1//`,
    `-cnf-line=ENCFONTS=${T}/fonts/enc//`,
    `-cnf-line=TEXFONTMAPS=${T}/fonts/map//`,
    '-output-directory=/project',
    '/project/hello.tex',
  ],
  env: { SELFAUTOLOC: '/bin', SELFAUTODIR: '/', SELFAUTOPARENT: '/' },
  preopens: {
    '/texmf-dist': TEXMF,
    '/project': workdir,
    '/bin': bindir,
  },
});

const bytes = readFileSync(WASM);
const mod = await WebAssembly.compile(bytes);
const instance = await WebAssembly.instantiate(mod, wasi.getImportObject());

process.chdir(workdir);
const t0 = performance.now();
let code = 0;
try {
  code = wasi.start(instance) ?? 0;
} catch (e) {
  console.error('[runtime error]', e.message, '\n', e.stack);
  code = 1;
}
const dur = performance.now() - t0;
console.log(`[smoke-wasi-compile] exit=${code}, ${dur.toFixed(0)} ms`);

const pdf = join(workdir, 'hello.pdf');
if (existsSync(pdf)) {
  const dst = join(REPO, 'hello-from-wasi.pdf');
  copyFileSync(pdf, dst);
  const sz = readFileSync(pdf).length;
  console.log(`✓ PDF: ${sz} bytes → hello-from-wasi.pdf`);
} else {
  console.log('✗ no PDF produced');
  const log = join(workdir, 'hello.log');
  if (existsSync(log)) console.log(readFileSync(log, 'utf8').slice(-1500));
  process.exit(1);
}
