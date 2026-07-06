#!/usr/bin/env node
/**
 * smoke-csl.mjs — citation-style-language (citeproc-lua) under lualatex.
 * The CSL processor is pure Lua and runs ENTIRELY inside the engine — no
 * external bibliography tool. Two passes settle the citations; verifies a
 * formatted APA-style bibliography lands in the PDF run.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TEXMF = join(REPO, 'engine-artifacts/texmf');

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

if (!tds.has('tex/latex/citation-style-language/citation-style-language.sty')) {
  console.error('✗ citation-style-language not in the TDS — re-run scripts/fetch-tds.sh');
  process.exit(1);
}

const MAIN_TEX = `\\documentclass{article}
\\usepackage[style=apa]{citation-style-language}
\\addbibresource{refs.bib}
\\begin{document}
Citing \\cite{knuth1968} and \\cite{lamport1994}.
\\printbibliography
\\end{document}
`;
const REFS_BIB = `@book{knuth1968,
  author = {Donald E. Knuth},
  title  = {The Art of Computer Programming},
  publisher = {Addison-Wesley},
  year   = {1968},
}
@book{lamport1994,
  author = {Leslie Lamport},
  title  = {LaTeX: A Document Preparation System},
  publisher = {Addison-Wesley},
  year   = {1994},
}
`;

const project = new Map([
  ['main.tex', new TextEncoder().encode(MAIN_TEX)],
  ['refs.bib', new TextEncoder().encode(REFS_BIB)],
]);

async function runPass(label) {
  const mod = await import(join(REPO, 'engine-artifacts/lualatex/emscripten/lualatex.js'));
  let out = '';
  const M = await mod.default({
    noInitialRun: true,
    thisProgram: '/bin/lualatex',
    print: (t) => (out += t + '\n'),
    printErr: (t) => (out += t + '\n'),
  });
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
  FS.writeFile('/bin/lualatex', new Uint8Array());
  mkdirP('/tmp/texmf-var');
  for (const [rel, bytes] of tds) {
    const abs = `/texmf-dist/${rel}`;
    mkdirP(dirname(abs));
    FS.writeFile(abs, bytes);
  }
  mkdirP('/project');
  for (const [rel, bytes] of project) {
    FS.writeFile(`/project/${rel}`, bytes);
  }
  FS.chdir('/project');

  const fmt = tds.has('web2c/luatex/lualatex.fmt')
    ? ['-fmt=/texmf-dist/web2c/luatex/lualatex.fmt']
    : [];
  let code;
  try {
    code = M.callMain([
      ...fmt,
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
      '-cnf-line=OPENTYPEFONTS=/texmf-dist/fonts/opentype//;/texmf-dist/fonts/truetype//;/texmf-dist/fonts/type1//',
      '-cnf-line=TRUETYPEFONTS=/texmf-dist/fonts/truetype//',
      '-cnf-line=LUAINPUTS=.;/texmf-dist/scripts//;/texmf-dist/tex//',
      '--no-shell-escape',
      '--interaction=nonstopmode',
      'main.tex',
    ]);
  } catch (e) {
    code = e?.status ?? -1;
  }
  for (const name of FS.readdir('/project')) {
    if (name === '.' || name === '..') continue;
    try {
      const st = FS.stat(`/project/${name}`);
      if ((st.mode & 0xf000) === 0x8000) project.set(name, FS.readFile(`/project/${name}`));
    } catch {}
  }
  console.log(`[${label}] exit=${code}`);
  return { code, out };
}

const p1 = await runPass('lualatex #1');
if (p1.code !== 0) {
  console.error('✗ pass 1 failed');
  console.error(p1.out.split('\n').slice(-25).join('\n'));
  process.exit(1);
}
const p2 = await runPass('lualatex #2');

const log = new TextDecoder().decode(project.get('main.log') ?? new Uint8Array());
if (p2.code !== 0 || !project.has('main.pdf')) {
  console.error('✗ final pass failed or produced no PDF');
  console.error((p2.out + '\n' + log).split('\n').slice(-30).join('\n'));
  process.exit(1);
}
if (/Citation .* undefined|There were undefined references/.test(log)) {
  console.error('✗ citations unresolved after 2 passes');
  console.error(log.split('\n').filter((l) => l.includes('Warning')).slice(-10).join('\n'));
  process.exit(1);
}
const pdf = project.get('main.pdf');
console.log(`✓ CSL (apa) via in-engine citeproc-lua: PDF ${pdf.length} bytes`);
