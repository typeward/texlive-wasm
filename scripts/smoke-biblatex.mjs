#!/usr/bin/env node
/**
 * smoke-biblatex.mjs — full biblatex `backend=bibtex` pipeline:
 * pdflatex → bibtexu --wolfgang → pdflatex ×2, mirroring what latexmk does
 * for `\usepackage[backend=bibtex]{biblatex}` documents. Verifies the .bbl
 * is produced, UTF-8 authors survive, and the final PDF resolves citations.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TEXMF = join(REPO, 'engine-artifacts/texmf');
const ICU_DATA = join(REPO, 'engine-artifacts/icudt78l.dat');

// Read the TDS once; each engine step needs a fresh instance (engines are
// not reentrant), so the tree is re-materialized per instance from memory.
const tds = new Map();
(function walk(abs, rel) {
  for (const n of readdirSync(abs)) {
    const a = join(abs, n);
    const r = rel ? `${rel}/${n}` : n;
    let s; try { s = statSync(a); } catch { continue; }
    if (s.isDirectory()) walk(a, r);
    else if (s.isFile()) { try { tds.set(r, readFileSync(a)); } catch {} }
  }
})(TEXMF, '');
console.log(`TDS files: ${tds.size}`);

const MAIN_TEX = `\\documentclass{article}
\\usepackage[backend=bibtex, style=authoryear]{biblatex}
\\addbibresource{refs.bib}
\\begin{document}
Citing \\cite{knuth1968} and \\cite{oelsen2020}.
\\printbibliography
\\end{document}
`;
const REFS_BIB = `@book{knuth1968,
  author = {Donald E. Knuth},
  title  = {The Art of Computer Programming},
  publisher = {Addison-Wesley},
  year   = {1968},
}
@article{oelsen2020,
  author  = {Ølsen, Kåre and Émile, Fournier},
  title   = {Unicode Authors Everywhere},
  journal = {Journal of Reproducible Smoke Tests},
  year    = {2020},
}
`;

const project = new Map([
  ['main.tex', new TextEncoder().encode(MAIN_TEX)],
  ['refs.bib', new TextEncoder().encode(REFS_BIB)],
]);

async function newInstance(engine) {
  const mod = await import(join(REPO, `engine-artifacts/${engine}/emscripten/${engine}.js`));
  let out = '';
  const M = await mod.default({
    noInitialRun: true,
    thisProgram: `/bin/${engine}`,
    print: (t) => (out += t + '\n'),
    printErr: (t) => (out += t + '\n'),
  });
  M.smokeOutput = () => out;
  const FS = M.FS;
  const exists = (p) => { try { FS.stat(p); return true; } catch { return false; } };
  const dirs = new Set(['/']);
  const dirname = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const mkdirP = (p) => {
    if (!p || dirs.has(p)) return;
    const parent = dirname(p);
    if (parent !== p) mkdirP(parent);
    if (!exists(p)) FS.mkdir(p);
    dirs.add(p);
  };
  mkdirP('/bin');
  FS.writeFile(`/bin/${engine}`, new Uint8Array());
  mkdirP('/tmp/texmf-var');
  for (const [rel, bytes] of tds) {
    const abs = `/texmf-dist/${rel}`;
    mkdirP(dirname(abs));
    FS.writeFile(abs, bytes);
  }
  mkdirP('/project');
  for (const [rel, bytes] of project) {
    const abs = `/project/${rel}`;
    mkdirP(dirname(abs));
    FS.writeFile(abs, bytes);
  }
  FS.chdir('/project');
  if (engine === 'bibtexu' && M._udata_setCommonData_78) {
    const icu = readFileSync(ICU_DATA);
    const ptr = M._malloc(icu.length);
    M.HEAPU8.set(icu, ptr);
    const errPtr = M._malloc(4);
    M.HEAPU32[errPtr >> 2] = 0;
    M._udata_setCommonData_78(ptr, errPtr);
  }
  return M;
}

function collectOutputs(M) {
  const FS = M.FS;
  for (const name of FS.readdir('/project')) {
    if (name === '.' || name === '..') continue;
    try {
      const st = FS.stat(`/project/${name}`);
      if ((st.mode & 0xf000) === 0x8000) project.set(name, FS.readFile(`/project/${name}`));
    } catch {}
  }
}

const TEX_ARGS = [
  '-cnf-line=TEXMFCNF=/texmf-dist/web2c',
  '-cnf-line=TEXMF=/texmf-dist',
  '-cnf-line=TEXMFDIST=/texmf-dist',
  '-cnf-line=TEXMFVAR=/tmp/texmf-var',
  '-cnf-line=TEXMFCACHE=/tmp/texmf-var',
  '-cnf-line=TEXINPUTS=.;/texmf-dist/tex//',
  '-cnf-line=TFMFONTS=/texmf-dist/fonts/tfm//',
  '-cnf-line=VFFONTS=/texmf-dist/fonts/vf//',
  '-cnf-line=T1FONTS=/texmf-dist/fonts/type1//',
  '-cnf-line=ENCFONTS=/texmf-dist/fonts/enc//',
  '-cnf-line=TEXFONTMAPS=/texmf-dist/fonts/map//',
  '--no-shell-escape',
  '--interaction=nonstopmode',
  'main.tex',
];

async function runStep(engine, args, label) {
  const M = await newInstance(engine);
  let code;
  try {
    code = M.callMain(args);
  } catch (e) {
    code = e?.status ?? -1;
  }
  collectOutputs(M);
  console.log(`[${label}] exit=${code}`);
  return { code, output: M.smokeOutput() };
}

const fmt = tds.has('web2c/pdftex/pdflatex.fmt') ? ['-fmt=/texmf-dist/web2c/pdftex/pdflatex.fmt'] : [];

// Pass 1: writes main.aux (+ main-blx.bib control file) referencing biblatex.bst.
const p1 = await runStep('pdflatex', [...fmt, ...TEX_ARGS], 'pdflatex #1');
if (!project.has('main.aux')) {
  console.error('✗ pass 1 produced no .aux');
  console.error(p1.output.split('\n').slice(-20).join('\n'));
  process.exit(1);
}

// bibtexu with biblatex's required wolfgang capacity mode.
const bib = await runStep('bibtexu', ['--wolfgang', '-l', 'en', 'main.aux'], 'bibtexu --wolfgang');
if (bib.code >= 2 || !project.has('main.bbl')) {
  console.error('✗ bibtexu failed or produced no .bbl');
  if (project.has('main.blg')) {
    console.error(new TextDecoder().decode(project.get('main.blg')).slice(-1500));
  }
  process.exit(1);
}
const bbl = new TextDecoder().decode(project.get('main.bbl'));
if (!bbl.includes('Knuth') || !bbl.includes('Ølsen')) {
  console.error('✗ .bbl missing expected authors (UTF-8 lost?):', bbl.slice(0, 800));
  process.exit(1);
}
console.log(`✓ .bbl: ${bbl.length} chars, UTF-8 authors intact`);

// Two settling passes: fold the .bbl in, then resolve authoryear labels.
await runStep('pdflatex', [...fmt, ...TEX_ARGS], 'pdflatex #2');
const p3 = await runStep('pdflatex', [...fmt, ...TEX_ARGS], 'pdflatex #3');

const log = new TextDecoder().decode(project.get('main.log') ?? new Uint8Array());
if (p3.code !== 0 || !project.has('main.pdf')) {
  console.error('✗ final pass failed or produced no PDF');
  console.error(log.split('\n').slice(-25).join('\n'));
  process.exit(1);
}
if (/Citation .* undefined|There were undefined references/.test(log)) {
  console.error('✗ citations still unresolved after 3 passes');
  console.error(log.split('\n').filter((l) => l.includes('Warning')).slice(-10).join('\n'));
  process.exit(1);
}
const pdf = project.get('main.pdf');
console.log(`✓ biblatex(backend=bibtex) PDF: ${pdf.length} bytes, citations resolved`);
