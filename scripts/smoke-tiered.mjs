#!/usr/bin/env node
/**
 * smoke-tiered.mjs — prove the per-engine CORE bundle is self-sufficient for
 * a representative document, with the full tree behind a lazy on-miss
 * resolver (exactly the worker's retry flow: run → parse missing names from
 * the log → resolve basename → exact path → materialize → retry).
 *
 * Prints every long-tail file the compile had to pull — that list is the
 * feedback loop for curating scripts/data/core-tier*.list.
 *
 * Tree source: engine-artifacts/texmf (default) or a tar via TEXMF_TAR=path
 * (dev convenience: point it at a downloaded texmf.tar.gz/.tar).
 *
 * Usage: node scripts/smoke-tiered.mjs [engine]   (default: pdflatex)
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const engine = process.argv[2] ?? 'pdflatex';

// ---- load the FULL tree into a map --------------------------------------
const full = new Map();
if (process.env.TEXMF_TAR) {
  let raw = readFileSync(process.env.TEXMF_TAR);
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);
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
    if (type === '0') {
      const rel = name.replace(/^texmf\//, '');
      if (rel) full.set(rel, raw.subarray(off, off + size));
    }
    off += Math.ceil(size / 512) * 512;
  }
} else {
  const TEXMF = join(REPO, 'engine-artifacts/texmf');
  (function walk(dir, rel) {
    for (const n of readdirSync(dir)) {
      const a = join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      let s; try { s = statSync(a); } catch { continue; }
      if (s.isDirectory()) walk(a, r);
      else if (s.isFile()) full.set(r, readFileSync(a));
    }
  })(TEXMF, '');
}
console.log(`full tree: ${full.size} files`);

// ---- core selection (same list files + glob semantics as pack-tds) ------
function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', ' ')
    .replaceAll('*', '[^/]*')
    .replaceAll(' ', '.*');
  return new RegExp(`^${escaped}$`);
}
const patterns = [];
for (const list of [
  join(REPO, 'scripts/data/core-tier.list'),
  join(REPO, `scripts/data/core-tier.${engine}.list`),
]) {
  if (!existsSync(list)) continue;
  for (const raw of readFileSync(list, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line && !line.startsWith('#')) patterns.push(globToRegex(line));
  }
}
const core = new Map();
for (const [path, bytes] of full) {
  // ALL=1 loads the whole tree through the same harness — bisects "file
  // missing from the core tier" vs "harness/setup difference".
  if (path !== 'ls-R' && (process.env.ALL || patterns.some((re) => re.test(path)))) {
    core.set(path, bytes);
  }
}
const coreBytes = [...core.values()].reduce((a, b) => a + b.length, 0);
console.log(`core tier: ${core.size} files, ${(coreBytes / 1048576).toFixed(1)} MB raw`);

// basename → exact paths over the FULL tree (the manifest role).
const nameIndex = new Map();
for (const path of full.keys()) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const arr = nameIndex.get(name);
  if (arr) arr.push(path);
  else nameIndex.set(name, [path]);
}

// ---- the worker's ls-R + missing-file machinery (same algorithms) -------
function buildLsR(paths) {
  const byDir = new Map();
  const entry = (dir, name) => {
    let set = byDir.get(dir);
    if (!set) byDir.set(dir, (set = new Set()));
    set.add(name);
  };
  for (const path of paths) {
    if (path === 'ls-R') continue;
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) entry(parts.slice(0, i).join('/'), parts[i]);
  }
  const lines = ['% ls-R -- filename database for kpathsea; do not change this line.'];
  for (const dir of [...byDir.keys()].sort()) lines.push('', `./${dir}:`, ...[...byDir.get(dir)].sort());
  return lines.join('\n') + '\n';
}

function parseMissing(log) {
  const out = new Set();
  for (const re of [
    /I can't find file `([^']+)'/g,
    /File `([^']+)' not found/g,
    /file `([^']+)' is not loadable/g,
    /Cannot find ([\w.-]+\.(?:sty|cls|fd|def|cfg|tfm|vf|pfb|otf|ttf|mf|enc|map))/gi,
    /! Font \\\S+=([\w.-]+)\s/g,
  ]) {
    let m;
    while ((m = re.exec(log)) !== null) {
      const name = m[1]?.trim();
      if (name && !name.includes('//') && !name.startsWith('-')) out.add(name);
    }
  }
  return [...out];
}

const DOCS = {
  pdflatex: `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{geometry}
\\usepackage{hyperref}
\\usepackage{booktabs}
\\begin{document}
\\section{Tiered loading}
Core bundle + lazy long tail. \\href{https://example.org}{A link} and
\\begin{equation}E=mc^2\\end{equation}
\\begin{tabular}{ll}\\toprule a & b \\\\ \\bottomrule\\end{tabular}
\\end{document}
`,
  xelatex: `\\documentclass{article}
\\begin{document}
XeTeX core-tier smoke — Latin Modern via fontconfig.
\\end{document}
`,
  lualatex: `\\documentclass{article}
\\begin{document}
LuaTeX core-tier smoke: $2^{10} = \\directlua{tex.sprint(2^10)}$
\\end{document}
`,
};

const loaded = new Map(core);
const fetched = [];
// Hard `! LaTeX Error: File not found` stops surface ONE miss per pass, so
// deep \RequirePackage chains need many rounds. The demo/site drain the
// full bundle (zero rounds); the mobile path resolves against local
// backends where extra rounds are cheap.
const MAX_RETRIES = 12;

async function attempt() {
  const m = await import(
    pathToFileURL(join(REPO, `engine-artifacts/${engine}/emscripten/${engine}.js`)).href
  );
  let out = '';
  const M = await m.default({
    noInitialRun: true,
    thisProgram: `/bin/${engine}`,
    print: (t) => (out += t + '\n'),
    printErr: (t) => (out += t + '\n'),
  });
  const FS = M.FS;
  const dirs = new Set(['/']);
  const dn = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const ex = (p) => { try { FS.stat(p); return true; } catch { return false; } };
  const mk = (p) => { if (!p || dirs.has(p)) return; const par = dn(p); if (par !== p) mk(par); if (!ex(p)) FS.mkdir(p); dirs.add(p); };
  mk('/bin');
  FS.writeFile(`/bin/${engine}`, new Uint8Array());
  mk('/project');
  mk('/tmp/texmf-var');
  mk('/texmf-dist');
  if (engine === 'xelatex') {
    // Same synthesized fontconfig setup as src/core/worker.ts.
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
    mk('/etc/fonts');
    mk('/usr/local/etc/fonts');
    mk('/tmp/fontcache');
    FS.writeFile('/etc/fonts/fonts.conf', FONTS_CONF);
    FS.writeFile('/usr/local/etc/fonts/fonts.conf', FONTS_CONF);
  }
  for (const [rel, bytes] of loaded) {
    const abs = `/texmf-dist/${rel}`;
    mk(dn(abs));
    FS.writeFile(abs, bytes);
  }
  FS.writeFile('/texmf-dist/ls-R', buildLsR(loaded.keys()));
  FS.writeFile('/project/main.tex', DOCS[engine]);
  FS.chdir('/project');
  if (engine === 'xelatex' && M._udata_setCommonData_78) {
    const icu = readFileSync(join(REPO, 'engine-artifacts/icudt78l.dat'));
    const ptr = M._malloc(icu.length);
    M.HEAPU8.set(icu, ptr);
    const errPtr = M._malloc(4);
    M.HEAPU32[errPtr >> 2] = 0;
    M._udata_setCommonData_78(ptr, errPtr);
  }
  const fmtPath = {
    pdflatex: 'web2c/pdftex/pdflatex.fmt',
    xelatex: 'web2c/xetex/xelatex.fmt',
    lualatex: 'web2c/luatex/lualatex.fmt',
  }[engine];
  let code;
  try {
    code = M.callMain([
      ...(loaded.has(fmtPath) ? [`-fmt=/texmf-dist/${fmtPath}`] : []),
      '-cnf-line=TEXMFCNF=/texmf-dist/web2c',
      '-cnf-line=TEXMF=/texmf-dist',
      '-cnf-line=TEXMFDIST=/texmf-dist',
      '-cnf-line=TEXMFVAR=/tmp/texmf-var',
      '-cnf-line=TEXMFCACHE=/tmp/texmf-var',
      '-cnf-line=TEXMFDBS=/texmf-dist',
      '-cnf-line=TEXINPUTS=.;/texmf-dist/tex//',
      '-cnf-line=TFMFONTS=/texmf-dist/fonts/tfm//',
      '-cnf-line=VFFONTS=/texmf-dist/fonts/vf//',
      '-cnf-line=T1FONTS=/texmf-dist/fonts/type1//',
      '-cnf-line=ENCFONTS=/texmf-dist/fonts/enc//',
      '-cnf-line=TEXFONTMAPS=/texmf-dist/fonts/map//',
      '-cnf-line=OPENTYPEFONTS=/texmf-dist/fonts/opentype//;/texmf-dist/fonts/truetype//',
      '-cnf-line=TRUETYPEFONTS=/texmf-dist/fonts/truetype//',
      // WASM XeTeX cannot popen its internal xdvipdfmx — latexmk holds the
      // .xdv and finalizes in a second engine; the smoke asserts the .xdv.
      ...(engine === 'xelatex' ? ['-no-pdf'] : []),
      '--no-shell-escape',
      '--interaction=nonstopmode',
      'main.tex',
    ]);
  } catch (e) {
    code = e?.status ?? -1;
  }
  const log = ex('/project/main.log')
    ? new TextDecoder().decode(FS.readFile('/project/main.log'))
    : out;
  const artifact = engine === 'xelatex' ? '/project/main.xdv' : '/project/main.pdf';
  const pdf = ex(artifact) ? FS.readFile(artifact) : null;
  return { code, log, out, pdf };
}

let result = null;
for (let round = 0; round <= MAX_RETRIES; round++) {
  result = await attempt();
  if (result.code === 0 && result.pdf) break;
  const missing = parseMissing(result.log + '\n' + result.out);
  let resolved = 0;
  for (const name of missing) {
    const paths = name.includes('/') ? [name] : (nameIndex.get(name) ?? []);
    for (const p of paths) {
      if (!loaded.has(p) && full.has(p)) {
        loaded.set(p, full.get(p));
        fetched.push(p);
        resolved++;
      }
    }
  }
  console.log(`round ${round + 1}: exit=${result.code}, missing=[${missing.join(', ')}], resolved=${resolved}`);
  if (resolved === 0) break;
}

console.log(`\nlazy-fetched long tail (${fetched.length}):`);
for (const f of fetched) console.log('  +', f);
if (result.code === 0 && result.pdf) {
  console.log(`\n✓ ${engine} core-tier compile OK — PDF ${result.pdf.length} bytes, ${fetched.length} lazy fetches`);
  process.exit(0);
}
console.error(`\n✗ ${engine} core-tier compile FAILED (exit ${result.code})`);
// DUMP_LOG=1 prints everything instead of the tail. Early fatals (bad fmt,
// missing config) never open a .log — fall back to captured stdio.
const text = result.log.trim() ? result.log : result.out;
console.error(text.split('\n').slice(process.env.DUMP_LOG ? 0 : -25).join('\n'));
process.exit(1);
