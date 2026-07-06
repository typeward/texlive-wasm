// gen-bcf.mjs — produce an authentic biblatex control file (.bcf) for the
// spike roundtrip by compiling a biber-backend document with OUR
// pdflatex.wasm against the repo TDS. Also writes the UTF-8 .bib the
// roundtrip sorts (50 entries so the timing criterion means something).
//
// Usage (in the builder container):
//   node gen-bcf.mjs <outdir>
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const OUT = process.argv[2] ?? '/tmp/roundtrip';
const REPO = '/workspace';
const TEXMF = join(REPO, 'engine-artifacts/texmf');
mkdirSync(OUT, { recursive: true });

// 50 entries with UTF-8 authors spread across the collation-sensitive range.
const SURNAMES = ['Ølsen', 'Émile', 'Zäh', 'Ábel', 'Østergård', 'Ćirić', 'Šimun', 'Żak', 'Ãlvares', 'Ñíguez'];
let bib = '';
for (let i = 0; i < 50; i++) {
  const s = SURNAMES[i % SURNAMES.length];
  bib += `@article{e${String(i).padStart(2, '0')},
  author  = {${s}, Given${i}},
  title   = {Entry number ${i} with some Unicode: ${s}},
  journal = {Journal of Roundtrips},
  volume  = {${(i % 9) + 1}},
  year    = {${1980 + (i % 40)}},
}
`;
}
writeFileSync(join(OUT, 'test.bib'), bib);

const TEX = `\\documentclass{article}
\\usepackage[style=authoryear]{biblatex}
\\addbibresource{test.bib}
\\begin{document}
\\nocite{*}
Roundtrip.
\\printbibliography
\\end{document}
`;

const tds = new Map();
(function walk(abs, rel) {
  for (const n of readdirSync(abs)) {
    const a = join(abs, n);
    const r = rel ? `${rel}/${n}` : n;
    let s; try { s = statSync(a); } catch { continue; }
    if (s.isDirectory()) walk(a, r);
    else if (s.isFile()) tds.set(r, readFileSync(a));
  }
})(TEXMF, '');

const mod = await import(
  pathToFileURL(join(REPO, 'engine-artifacts/pdflatex/emscripten/pdflatex.js')).href
);
let out = '';
const M = await mod.default({
  noInitialRun: true,
  thisProgram: '/bin/pdflatex',
  print: (t) => (out += t + '\n'),
  printErr: (t) => (out += t + '\n'),
});
const FS = M.FS;
const dirs = new Set(['/']);
const dn = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const ex = (p) => { try { FS.stat(p); return true; } catch { return false; } };
const mk = (p) => { if (!p || dirs.has(p)) return; const par = dn(p); if (par !== p) mk(par); if (!ex(p)) FS.mkdir(p); dirs.add(p); };
mk('/bin');
FS.writeFile('/bin/pdflatex', new Uint8Array());
mk('/project');
mk('/tmp/texmf-var');
mk('/texmf-dist');
for (const [rel, bytes] of tds) {
  const abs = `/texmf-dist/${rel}`;
  mk(dn(abs));
  FS.writeFile(abs, bytes);
}
FS.writeFile('/project/test.tex', TEX);
FS.writeFile('/project/test.bib', bib);
FS.chdir('/project');
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
    '--no-shell-escape',
    '--interaction=nonstopmode',
    'test.tex',
  ]);
} catch (e) {
  code = e?.status ?? -1;
}
// Pass 1 of a biber-backend doc: citations unresolved (expected), but the
// .bcf must exist.
if (!ex('/project/test.bcf')) {
  console.error(`gen-bcf: pdflatex exit=${code}, no .bcf produced`);
  console.error(out.split('\n').slice(-20).join('\n'));
  process.exit(1);
}
writeFileSync(join(OUT, 'test.bcf'), FS.readFile('/project/test.bcf'));
console.log(`gen-bcf: wrote ${OUT}/test.bcf (pdflatex exit=${code}, biblatex control file v` +
  (new TextDecoder().decode(FS.readFile('/project/test.bcf')).match(/version="([^"]+)"/)?.[1] ?? '?') + ')');
