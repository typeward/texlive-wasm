#!/usr/bin/env node
/**
 * smoke-makeindex.mjs — exercise the makeindex engine: write a .idx,
 * invoke makeindex, verify it produces a .ind with the expected entries.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('..', import.meta.url));
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

const IDX = `\\indexentry{algorithm}{2}
\\indexentry{algorithm}{7}
\\indexentry{binary tree}{5}
\\indexentry{recursion}{3}
\\indexentry{recursion}{8}
`;

const mod = await import(pathToFileURL(join(REPO, 'engine-artifacts/makeindex/emscripten/makeindex.js')).href);
const M = await mod.default({
  noInitialRun: true,
  thisProgram: '/bin/makeindex',
  print: (t) => process.stdout.write(t + '\n'),
  printErr: (t) => process.stderr.write(t + '\n'),
});

walk(M.FS, TEXMF, '/texmf-dist');
M.FS.mkdir('/bin');
M.FS.writeFile('/bin/makeindex', new Uint8Array());
M.FS.mkdir('/project');
M.FS.chdir('/project');
M.FS.writeFile('/project/sample.idx', IDX);

let code;
try {
  code = M.callMain(['sample.idx']);
} catch (e) { code = e?.status ?? -1; }
console.log(`makeindex exit=${code}`);

if (!M.FS.analyzePath('/project/sample.ind').exists) {
  console.error('✗ no .ind produced');
  if (M.FS.analyzePath('/project/sample.ilg').exists) {
    console.error(new TextDecoder().decode(M.FS.readFile('/project/sample.ilg')).slice(-1500));
  }
  process.exit(1);
}

const ind = M.FS.readFile('/project/sample.ind');
const text = new TextDecoder().decode(ind);
if (!text.includes('algorithm') || !text.includes('recursion')) {
  console.error('✗ .ind missing expected entries:', text.slice(0, 500));
  process.exit(1);
}
writeFileSync(join(REPO, 'sample-from-wasm.ind'), ind);
console.log(`✓ .ind: ${ind.length} bytes → sample-from-wasm.ind`);
