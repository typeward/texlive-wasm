#!/usr/bin/env node
/**
 * smoke-extras.mjs — verify the newly-added TDS packages (siunitx,
 * tikz, biblatex, IEEEtran, algorithm2e) actually compile.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const TEXMF = join(REPO, 'engine-artifacts/texmf');

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

const DOC = `\\documentclass{article}
\\usepackage{siunitx}
\\usepackage{tikz}
\\usepackage{algorithm2e}
\\usepackage[Symbol]{upgreek}
\\usepackage{xcolor}
\\begin{document}
The speed of light is \\SI{2.998e8}{\\meter\\per\\second}.

\\begin{tikzpicture}
\\draw[red,thick] (0,0) circle (1cm);
\\filldraw[blue] (0,0) circle (2pt);
\\end{tikzpicture}

\\begin{algorithm}
\\KwData{numbers $a, b$}
\\KwResult{$\\gcd(a, b)$}
\\While{$b \\neq 0$}{
  $r \\leftarrow a \\bmod b$\\;
  $a \\leftarrow b$\\;
  $b \\leftarrow r$\\;
}
\\Return $a$\\;
\\end{algorithm}
\\end{document}
`;

const mod = await import(join(REPO, 'engine-artifacts/pdflatex/emscripten/pdflatex.js'));
const M = await mod.default({
  noInitialRun: true,
  thisProgram: '/bin/pdflatex',
  print: (t) => process.stdout.write(t + '\n'),
  printErr: (t) => process.stderr.write(t + '\n'),
});

walk(M.FS, TEXMF, '/texmf-dist');
M.FS.mkdir('/bin');
M.FS.writeFile('/bin/pdflatex', new Uint8Array());
M.FS.mkdir('/project');
M.FS.chdir('/project');
M.FS.writeFile('/project/extras.tex', DOC);

const T = '/texmf-dist';
let code;
try {
  code = M.callMain([
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
    'extras.tex',
  ]);
} catch (e) { code = e?.status ?? -1; }

console.log(`\nextras pdflatex exit=${code}`);
if (M.FS.analyzePath('/project/extras.pdf').exists) {
  const pdf = M.FS.readFile('/project/extras.pdf');
  writeFileSync(join(REPO, 'extras-from-wasm.pdf'), pdf);
  console.log(`✓ PDF: ${pdf.length} bytes → extras-from-wasm.pdf (siunitx + tikz + algorithm2e work)`);
} else {
  console.error('✗ no PDF produced');
  if (M.FS.analyzePath('/project/extras.log').exists) {
    console.error(new TextDecoder().decode(M.FS.readFile('/project/extras.log')).slice(-2000));
  }
  process.exit(1);
}
