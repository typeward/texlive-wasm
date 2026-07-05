#!/usr/bin/env node
/**
 * smoke-lualatex.mjs — end-to-end LaTeX compile through our wasm
 * lualatex (luahbtex). Produces hello-from-wasm-lualatex.pdf in cwd.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEXMF = join(REPO_ROOT, 'engine-artifacts/texmf');

function walk(FS, absDir, mfsDir) {
  if (!FS.analyzePath(mfsDir).exists) FS.mkdir(mfsDir);
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name);
    const mfs = mfsDir + '/' + name;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(FS, abs, mfs);
    else if (st.isFile()) { try { FS.writeFile(mfs, readFileSync(abs)); } catch {} }
  }
}

function mkdirP(FS, p) {
  if (!p || p === '/') return;
  let exists = false;
  try { exists = FS.analyzePath(p).exists; } catch {}
  if (exists) return;
  const i = p.lastIndexOf('/');
  mkdirP(FS, i <= 0 ? '/' : p.slice(0, i));
  try { FS.mkdir(p); } catch {}
}

const FONTS_CONF = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/texmf-dist/fonts/opentype</dir>
  <dir>/texmf-dist/fonts/truetype</dir>
  <dir>/texmf-dist/fonts/type1</dir>
  <cachedir>/tmp/fontcache</cachedir>
  <config><rescan><int>0</int></rescan></config>
</fontconfig>
`;

const TEX_SOURCE = `\\documentclass{article}
\\begin{document}
Hello from lualatex on WASM. $E = mc^2$
\\end{document}
`;

const mod = await import(join(REPO_ROOT, 'engine-artifacts/lualatex/emscripten/lualatex.js'));
const M = await mod.default({
  noInitialRun: true,
  thisProgram: '/bin/lualatex',
  print: (t) => process.stdout.write(t + '\n'),
  printErr: (t) => process.stderr.write(t + '\n'),
});

walk(M.FS, TEXMF, '/texmf-dist');
mkdirP(M.FS, '/etc/fonts');
mkdirP(M.FS, '/tmp/fontcache');
M.FS.writeFile('/etc/fonts/fonts.conf', FONTS_CONF);
mkdirP(M.FS, '/usr/local/etc/fonts');
M.FS.writeFile('/usr/local/etc/fonts/fonts.conf', FONTS_CONF);
M.FS.mkdir('/bin');
M.FS.writeFile('/bin/lualatex', new Uint8Array());
M.FS.mkdir('/project');
M.FS.chdir('/project');
M.FS.writeFile('/project/hello.tex', TEX_SOURCE);

const T = '/texmf-dist';
let exitCode;
try {
  exitCode = M.callMain([
    '-interaction=nonstopmode',
    `-fmt=${T}/web2c/luatex/lualatex.fmt`,
    `-cnf-line=TEXMFCNF=${T}/web2c`,
    `-cnf-line=TEXMF=${T}`,
    `-cnf-line=TEXMFDIST=${T}`,
    `-cnf-line=TEXINPUTS=.;${T}/tex//`,
    `-cnf-line=TFMFONTS=${T}/fonts/tfm//`,
    `-cnf-line=OPENTYPEFONTS=${T}/fonts/opentype//;${T}/fonts/truetype//;${T}/fonts/type1//`,
    `-cnf-line=TRUETYPEFONTS=${T}/fonts/truetype//`,
    `-cnf-line=ENCFONTS=${T}/fonts/enc//`,
    `-cnf-line=LUAINPUTS=${T}/tex/luatex//;${T}/scripts//;${T}/tex//`,
    `-cnf-line=CLUAINPUTS=${T}/tex/luatex//;.`,
    'hello.tex',
  ]);
} catch (e) { exitCode = e?.status ?? -1; }
console.log(`lualatex exit=${exitCode}`);
console.log('Files in /project after compile:');
for (const n of M.FS.readdir('/project')) {
  if (n === '.' || n === '..') continue;
  try { console.log('  ', n, M.FS.stat('/project/'+n).size); } catch {}
}
console.log('Files in /:');
for (const n of M.FS.readdir('/')) {
  if (n === '.' || n === '..') continue;
  try {
    const st = M.FS.stat('/'+n);
    if (M.FS.isFile(st.mode)) console.log('  /'+n, st.size);
  } catch {}
}

// Dump the log so we can see why PDF didn't appear (if applicable).
if (M.FS.analyzePath('/project/hello.log').exists) {
  const log = new TextDecoder().decode(M.FS.readFile('/project/hello.log'));
  const errLines = log.split('\n').filter((l) => /^! |error|Error|warning|Warning/.test(l));
  if (errLines.length) {
    console.log('Errors/warnings in hello.log:');
    for (const l of errLines.slice(0, 10)) console.log(' ', l);
  }
}

if (M.FS.analyzePath('/project/hello.pdf').exists) {
  const pdf = M.FS.readFile('/project/hello.pdf');
  writeFileSync(join(REPO_ROOT, 'hello-from-wasm-lualatex.pdf'), pdf);
  console.log(`✓ PDF: ${pdf.length} bytes → hello-from-wasm-lualatex.pdf`);
  process.exit(0);
} else {
  console.error('✗ no PDF produced');
  if (M.FS.analyzePath('/project/hello.log').exists) {
    console.error(new TextDecoder().decode(M.FS.readFile('/project/hello.log')).slice(-2000));
  }
  process.exit(1);
}
