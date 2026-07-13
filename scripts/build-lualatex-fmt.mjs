#!/usr/bin/env node
/**
 * build-lualatex-fmt.mjs — generate lualatex.fmt with our wasm luahbtex.
 *
 * Run AFTER scripts/fetch-tds.sh.
 *
 * Output: engine-artifacts/texmf/web2c/luatex/lualatex.fmt
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEXMF = join(REPO_ROOT, 'engine-artifacts/texmf');
const ENGINE_JS = join(REPO_ROOT, 'engine-artifacts/lualatex/emscripten/lualatex.js');

// import() takes a URL, not a path: a bare absolute path works on POSIX but
// the ESM loader rejects "C:\..." as an unknown scheme.
const m = await import(pathToFileURL(ENGINE_JS).href);

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
  thisProgram: '/bin/lualatex',
  print: (t) => process.stdout.write(t + '\n'),
  printErr: (t) => process.stderr.write(t + '\n'),
});

walk(Module.FS, TEXMF, '/texmf-dist');
Module.FS.mkdir('/bin');
Module.FS.writeFile('/bin/lualatex', new Uint8Array());
Module.FS.mkdir('/work');
Module.FS.chdir('/work');

console.error('[build-lualatex-fmt] building lualatex.fmt...');
const t0 = Date.now();
let exitCode;
try {
  exitCode = Module.callMain([
    '-ini',
    '-interaction=nonstopmode',
    '-jobname=lualatex',
    '-cnf-line=TEXMFCNF=/texmf-dist/web2c',
    '-cnf-line=TEXMF=/texmf-dist',
    '-cnf-line=TEXMFDIST=/texmf-dist',
    '-cnf-line=TEXINPUTS=.;/texmf-dist/tex//',
    '-cnf-line=TFMFONTS=/texmf-dist/fonts/tfm//',
    '-cnf-line=OPENTYPEFONTS=/texmf-dist/fonts/opentype//;/texmf-dist/fonts/truetype//;/texmf-dist/fonts/type1//',
    '-cnf-line=TRUETYPEFONTS=/texmf-dist/fonts/truetype//',
    '-cnf-line=LUAINPUTS=/texmf-dist/tex/luatex//;/texmf-dist/scripts//;/texmf-dist/tex//',
    '-cnf-line=CLUAINPUTS=/texmf-dist/tex/luatex//;.',
    '/texmf-dist/tex/latex/tex-ini-files/lualatex.ini',
  ]);
} catch (e) {
  exitCode = e?.status ?? -1;
  console.error('[build-lualatex-fmt] exception:', e?.message ?? e, '\n', e?.stack);
}
console.error(`[build-lualatex-fmt] exit=${exitCode} in ${Date.now() - t0}ms`);

// The .fmt existing is not proof of a good build: -interaction=nonstopmode
// carries on past errors and still dumps a format made from a half-loaded
// latex.ltx, which then fails at compile time on a user's machine. Gate on the
// engine's exit status and on the log the engine actually wrote.
const log = readLog(Module, '/work/lualatex.log');
const problems = [];
if (exitCode !== 0) problems.push(`engine exited with ${exitCode}`);
problems.push(...fatalMarkers(log));
if (!Module.FS.analyzePath('/work/lualatex.fmt').exists) problems.push('no fmt produced');

if (problems.length > 0) {
  console.error('[build-lualatex-fmt] FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  if (log) console.error(log.slice(-2500));
  process.exit(1);
}

const fmt = Module.FS.readFile('/work/lualatex.fmt');
const outPath = join(TEXMF, 'web2c/luatex/lualatex.fmt');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, fmt);
console.error(`[build-lualatex-fmt] wrote ${outPath} (${fmt.length} bytes)`);

function readLog(mod, path) {
  if (!mod.FS.analyzePath(path).exists) return '';
  return new TextDecoder().decode(mod.FS.readFile(path));
}

/** TeX's own fatal vocabulary — an error line, a stop, an abort. */
function fatalMarkers(text) {
  if (!text) return [];
  const found = [];
  const error = text.match(/^! .*$/m);
  if (error) found.push(`TeX error in the log: ${error[0].trim()}`);
  if (text.includes('Emergency stop')) found.push('Emergency stop in the log');
  if (text.includes('Fatal error occurred')) found.push('fatal error in the log');
  return found;
}
