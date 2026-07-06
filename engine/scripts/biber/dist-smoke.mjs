// dist-smoke.mjs — validate the BROWSER biber artifact the way the library
// worker will consume it: MODULARIZE factory, MEMFS populated from
// biber-vfs.tar.gz, callMain with a fresh instance per run. No host fs.
//
// Usage: node dist-smoke.mjs <build-dir>
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const BUILD = process.argv[2];
const OUT = join(BUILD, 'emscripten');

// --- untar the VFS (same header logic the library's tar.ts uses) ---------
const raw = gunzipSync(readFileSync(join(OUT, 'biber-vfs.tar.gz')));
const files = new Map();
{
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
    if (type === '0' && name) files.set(name, raw.subarray(off, off + size));
    off += Math.ceil(size / 512) * 512;
  }
}
console.log(`vfs: ${files.size} files, ${(raw.length / 1048576).toFixed(1)} MB raw`);

const factory = (await import(pathToFileURL(join(OUT, 'biber.js')).href)).default;

async function run(args, project = new Map()) {
  let out = '';
  const M = await factory({
    noInitialRun: true,
    thisProgram: '/biber/bin/biber',
    print: (t) => (out += t + '\n'),
    printErr: (t) => (out += t + '\n'),
  });
  const FS = M.FS;
  const dirs = new Set(['/']);
  const dn = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const ex = (p) => { try { FS.stat(p); return true; } catch { return false; } };
  const mk = (p) => { if (!p || dirs.has(p)) return; const par = dn(p); if (par !== p) mk(par); if (!ex(p)) FS.mkdir(p); dirs.add(p); };
  for (const [rel, bytes] of files) {
    const abs = `/${rel}`;
    mk(dn(abs));
    FS.writeFile(abs, bytes);
  }
  mk('/project');
  for (const [rel, bytes] of project) FS.writeFile(`/project/${rel}`, bytes);
  FS.chdir('/project');
  let code;
  try {
    code = M.callMain(args);
  } catch (e) {
    code = e?.status ?? -1;
  }
  const outputs = new Map();
  for (const name of FS.readdir('/project')) {
    if (name === '.' || name === '..') continue;
    try {
      const st = FS.stat(`/project/${name}`);
      if ((st.mode & 0xf000) === 0x8000) outputs.set(name, FS.readFile(`/project/${name}`));
    } catch {}
  }
  return { code, out, outputs };
}

// 1. --version (fresh instance)
{
  const t0 = performance.now();
  const r = await run(['/biber/bin/biber', '--version']);
  console.log(`--version: exit=${r.code}, ${(performance.now() - t0).toFixed(0)} ms`);
  console.log('  ' + r.out.trim().split('\n')[0]);
  if (r.code !== 0 || !r.out.includes('2.19')) { console.error(r.out.slice(-1500)); process.exit(1); }
}

// 2. roundtrip fixture (fresh instance, all in MEMFS). The fixture needs
// pdflatex artifacts + a TDS (stage roundtrip) — absent in the CI matrix
// leg that only builds biber, so skip gracefully there.
{
  const rt = join(BUILD, 'roundtrip');
  let bcf;
  try {
    bcf = readFileSync(join(rt, 'test.bcf'));
  } catch {
    console.log('roundtrip fixture absent (CI leg without pdflatex) — --version smoke only');
    process.exit(0);
  }
  const project = new Map([
    ['test.bcf', bcf],
    ['test.bib', readFileSync(join(rt, 'test.bib'))],
  ]);
  const t0 = performance.now();
  const r = await run(['/biber/bin/biber', '--noconf', 'test'], project);
  const ms = (performance.now() - t0).toFixed(0);
  const bbl = r.outputs.get('test.bbl');
  console.log(`roundtrip: exit=${r.code}, ${ms} ms, .bbl=${bbl ? bbl.length + ' bytes' : 'NONE'}`);
  if (r.code !== 0 || !bbl) { console.error(r.out.split('\n').slice(-15).join('\n')); process.exit(1); }
  const golden = readFileSync(join(rt, 'test-wasm.bbl'));
  const same = bbl.length === golden.length && Buffer.compare(Buffer.from(bbl), golden) === 0;
  console.log(same ? 'PASS: matches the NODERAWFS roundtrip output byte-for-byte'
                   : 'FAIL: differs from the roundtrip output');
  process.exit(same ? 0 : 1);
}
