#!/usr/bin/env node
/**
 * smoke-biber.mjs — the full DEFAULT-BACKEND biblatex pipeline:
 * pdflatex → biber.wasm → pdflatex ×2, mirroring latexmk's biber flow.
 * UTF-8 authors must sort under real UCA and citations must resolve.
 *
 * Requires engine-artifacts/{pdflatex,biber}/emscripten + texmf.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TEXMF = join(REPO, 'engine-artifacts/texmf');

// TDS read once; fresh engine instance per step (engines aren't reentrant).
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

// biber VFS (perl/ + biber/ trees, mounted at /).
const vfs = new Map();
{
  const raw = gunzipSync(readFileSync(join(REPO, 'engine-artifacts/biber/emscripten/biber-vfs.tar.gz')));
  const readC = (b, s, l) => { let e = s; while (e < s + l && b[e] !== 0) e++; return b.slice(s, e).toString(); };
  const oct = (b, s, l) => parseInt(readC(b, s, l).trim() || '0', 8) || 0;
  let off = 0;
  while (off + 512 <= raw.length) {
    const h = raw.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const prefix = readC(h, 345, 155);
    const name = (prefix ? prefix + '/' : '') + readC(h, 0, 100);
    const size = oct(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    off += 512;
    if (type === '0' && name) vfs.set(name, raw.subarray(off, off + size));
    off += Math.ceil(size / 512) * 512;
  }
}

const MAIN_TEX = `\\documentclass{article}
\\usepackage[style=authoryear]{biblatex}
\\addbibresource{refs.bib}
\\begin{document}
Citing \\cite{knuth1968} and \\cite{oelsen2020} through real biber.

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
  author  = {Ølsen, Kåre and Ábel, Tamás},
  title   = {Unicode Collation Everywhere},
  journal = {Journal of Reproducible Smoke Tests},
  year    = {2020},
}
`;

const project = new Map([
  ['main.tex', new TextEncoder().encode(MAIN_TEX)],
  ['refs.bib', new TextEncoder().encode(REFS_BIB)],
]);

function fsHelpers(FS) {
  const dirs = new Set(['/']);
  const dn = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const ex = (p) => { try { FS.stat(p); return true; } catch { return false; } };
  const mk = (p) => { if (!p || dirs.has(p)) return; const par = dn(p); if (par !== p) mk(par); if (!ex(p)) FS.mkdir(p); dirs.add(p); };
  return { dn, ex, mk };
}

function collect(FS) {
  for (const name of FS.readdir('/project')) {
    if (name === '.' || name === '..') continue;
    try {
      const st = FS.stat(`/project/${name}`);
      if ((st.mode & 0xf000) === 0x8000) project.set(name, FS.readFile(`/project/${name}`));
    } catch {}
  }
}

async function runPdflatex(label) {
  const m = await import(pathToFileURL(join(REPO, 'engine-artifacts/pdflatex/emscripten/pdflatex.js')).href);
  let out = '';
  const M = await m.default({
    noInitialRun: true,
    thisProgram: '/bin/pdflatex',
    print: (t) => (out += t + '\n'),
    printErr: (t) => (out += t + '\n'),
  });
  const { dn, ex, mk } = fsHelpers(M.FS);
  mk('/bin'); M.FS.writeFile('/bin/pdflatex', new Uint8Array());
  mk('/project'); mk('/tmp/texmf-var'); mk('/texmf-dist');
  for (const [rel, bytes] of tds) { const abs = `/texmf-dist/${rel}`; mk(dn(abs)); M.FS.writeFile(abs, bytes); }
  for (const [rel, bytes] of project) M.FS.writeFile(`/project/${rel}`, bytes);
  M.FS.chdir('/project');
  let code;
  try {
    code = M.callMain([
      ...(tds.has('web2c/pdftex/pdflatex.fmt') ? ['-fmt=/texmf-dist/web2c/pdftex/pdflatex.fmt'] : []),
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
      '--no-shell-escape', '--interaction=nonstopmode', 'main.tex',
    ]);
  } catch (e) { code = e?.status ?? -1; }
  collect(M.FS);
  console.log(`[${label}] exit=${code}`);
  return { code, out };
}

async function runBiber(label) {
  const m = await import(pathToFileURL(join(REPO, 'engine-artifacts/biber/emscripten/biber.js')).href);
  let out = '';
  const M = await m.default({
    noInitialRun: true,
    thisProgram: '/biber/bin/biber',
    print: (t) => (out += t + '\n'),
    printErr: (t) => (out += t + '\n'),
  });
  const { dn, ex, mk } = fsHelpers(M.FS);
  for (const [rel, bytes] of vfs) { const abs = `/${rel}`; mk(dn(abs)); M.FS.writeFile(abs, bytes); }
  mk('/project');
  for (const [rel, bytes] of project) M.FS.writeFile(`/project/${rel}`, bytes);
  M.FS.chdir('/project');
  let code;
  try {
    code = M.callMain(['/biber/bin/biber', '--noconf', 'main']);
  } catch (e) { code = e?.status ?? -1; }
  collect(M.FS);
  console.log(`[${label}] exit=${code}`);
  return { code, out };
}

const p1 = await runPdflatex('pdflatex #1');
if (!project.has('main.bcf')) {
  console.error('✗ no .bcf produced');
  console.error(p1.out.split('\n').slice(-20).join('\n'));
  process.exit(1);
}

const b = await runBiber('biber');
if (b.code !== 0 || !project.has('main.bbl')) {
  console.error('✗ biber failed or produced no .bbl');
  console.error(b.out.split('\n').slice(-20).join('\n'));
  process.exit(1);
}
const bbl = new TextDecoder().decode(project.get('main.bbl'));
if (!bbl.includes('Knuth') || !bbl.includes('Ølsen')) {
  console.error('✗ .bbl missing expected authors:', bbl.slice(0, 500));
  process.exit(1);
}
console.log(`✓ biber .bbl: ${bbl.length} chars, UTF-8 authors intact`);

await runPdflatex('pdflatex #2');
const p3 = await runPdflatex('pdflatex #3');

const log = new TextDecoder().decode(project.get('main.log') ?? new Uint8Array());
if (p3.code !== 0 || !project.has('main.pdf')) {
  console.error('✗ final pass failed or produced no PDF');
  console.error(log.split('\n').slice(-25).join('\n'));
  process.exit(1);
}
if (/Citation .* undefined|There were undefined references/.test(log)) {
  console.error('✗ citations unresolved after biber + 2 passes');
  process.exit(1);
}
console.log(`✓ biblatex+biber (default backend) PDF: ${project.get('main.pdf').length} bytes, citations resolved`);
