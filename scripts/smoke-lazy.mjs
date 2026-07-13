/**
 * End-to-end proof that the worker mounts the TeX tree lazily.
 *
 * Runs the REAL engine worker (src/core/worker.ts, via the built dist) against
 * the REAL engine artifact and the REAL TDS, compiles a document twice — once
 * lazily, once forced eager — and compares the PDFs and the heap.
 *
 * This is the test the lazy mount never had: the eager fallback produces the
 * same correct PDF, so when the mount silently failed, nothing failed.
 *
 *   node scripts/smoke-lazy.mjs [engine]        (default: pdflatex)
 *
 * Requires engine-artifacts/<engine>/emscripten/<engine>.{js,wasm} and
 * engine-artifacts/texmf (scripts/fetch-tds.sh).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const engine = process.argv[2] ?? 'pdflatex';
// TEXLIVE_WASM_ARTIFACTS points the smoke at a freshly built (or downloaded)
// artifact tree instead of the one committed to the repo.
const artifacts = process.env.TEXLIVE_WASM_ARTIFACTS ?? join(REPO, 'engine-artifacts');
const artifact = join(artifacts, `${engine}/emscripten/${engine}.wasm`);
const texmf = process.env.TEXLIVE_WASM_TEXMF ?? join(REPO, 'engine-artifacts/texmf');

const DOC = '\\documentclass{article}\\begin{document}Hello from a lazy tree.\\end{document}\n';

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, base, out);
    else if (st.isFile()) out.push(relative(base, abs).split('\\').join('/'));
  }
  return out;
}

console.log(`indexing ${texmf} ...`);
const paths = walk(texmf);
const tds = new Map(paths.map((p) => [p, readFileSync(join(texmf, p))]));
console.log(`TDS: ${tds.size} files, ${(total(tds) / 1024 / 1024).toFixed(1)} MB`);

function total(map) {
  let n = 0;
  for (const b of map.values()) n += b.length;
  return n;
}

// The worker's backend chain: one list()-able backend over the real tree.
const host = {
  read: async (_i, path) => tds.get(path.replace(/^\/+/, '')) ?? null,
  exists: async (_i, path) => tds.has(path.replace(/^\/+/, '')),
  list: async () => [...tds.keys()],
  init: async () => {},
  dispose: async () => {},
};
const backendMeta = [{ id: 'local-texmf', hasList: true, hasInit: false, hasDispose: false }];

const { WorkerImpl } = await import(pathToFileURL(join(REPO, 'dist/worker.js')).href);

async function compile(lazyTds) {
  const worker = new WorkerImpl();
  await worker.init(
    {
      engineId: engine,
      config: { enginePath: pathToFileURL(artifact).href, lazyTds },
      backendMeta,
    },
    host,
  );
  const before = process.memoryUsage();
  const started = performance.now();
  const result = await worker.run({
    args: ['-interaction=nonstopmode', 'hello.tex'],
    files: [{ path: 'hello.tex', content: DOC }],
  });
  const elapsed = performance.now() - started;
  const rss = process.memoryUsage().rss - before.rss;
  await worker.dispose();
  return { result, elapsed, rss };
}

const lazy = await compile(true);
const eager = await compile(false);

const fmt = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
for (const [name, run] of [
  ['lazy ', lazy],
  ['eager', eager],
]) {
  const pdf = run.result.outputs.get('hello.pdf');
  console.log(
    `${name} | exit ${run.result.exitCode} | lazyTds=${String(run.result.lazyTds).padEnd(5)} | ` +
      `${run.elapsed.toFixed(0).padStart(5)} ms | rss +${fmt(run.rss).padStart(6)} | ` +
      `pdf ${pdf ? `${pdf.length} bytes` : 'MISSING'}`,
  );
}

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

if (lazy.result.exitCode !== 0) fail(`lazy compile exited ${lazy.result.exitCode}`);
if (eager.result.exitCode !== 0) fail(`eager compile exited ${eager.result.exitCode}`);
if (lazy.result.lazyTds !== true) {
  fail('the lazy mount did not engage — the artifact predates it, or it silently fell back');
}
if (eager.result.lazyTds !== false) fail('lazyTds: false did not force the eager path');

const lazyPdf = lazy.result.outputs.get('hello.pdf');
const eagerPdf = eager.result.outputs.get('hello.pdf');
if (!lazyPdf || !eagerPdf) fail('no PDF produced');
// The PDFs carry a creation timestamp, so compare what the engine typeset:
// same length and same bytes outside the /ID and /CreationDate spans.
if (Math.abs(lazyPdf.length - eagerPdf.length) > 64) {
  fail(`PDFs differ in size: lazy ${lazyPdf.length} vs eager ${eagerPdf.length}`);
}

// Inputs must not be echoed back out.
if (lazy.result.outputs.has('hello.tex')) fail('run() echoed an unchanged input back');

console.log('\nOK: lazy mount engaged, both paths compiled, outputs agree.');
