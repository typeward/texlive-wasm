#!/usr/bin/env node
/**
 * smoke-all.mjs — run every engine smoke test and report pass/fail.
 *
 * Used as the canary that "our custom wasm is able to compile latex
 * using all engines."
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// The wasi smoke needs Wasm EH support, which landed in Node 22. Use the
// running Node when it's new enough; otherwise fall back to a side-installed
// binary (CI convenience) before skipping.
const NODE_22_FALLBACK = '/tmp/node-v22.13.0-linux-x64/bin/node';
const runningMajor = Number(process.versions.node.split('.')[0]);
const NODE_FOR_WASI =
  runningMajor >= 22 ? process.execPath : existsSync(NODE_22_FALLBACK) ? NODE_22_FALLBACK : null;

const SMOKES = [
  ['pdflatex',  'smoke-pdflatex.mjs', false],
  ['xelatex',   'smoke-xelatex.mjs', false],
  ['lualatex',  'smoke-lualatex.mjs', false],
  ['bibtexu',   'smoke-bibtexu.mjs', false],
  ['makeindex', 'smoke-makeindex.mjs', false],
  ['wasi',      'smoke-wasi-compile.mjs', true],
];

const results = [];
for (const [name, script, needsNode22] of SMOKES) {
  if (needsNode22 && !NODE_FOR_WASI) {
    console.log(`[SKIP] ${name.padEnd(10)} (needs Node 22+ for wasm EH; current is ${process.versions.node})`);
    continue;
  }
  const t0 = Date.now();
  const path = join(HERE, script);
  const bin = needsNode22 ? NODE_FOR_WASI : process.execPath;
  const r = spawnSync(bin, [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  const tail = (r.stdout + r.stderr).split('\n').filter(Boolean).slice(-3).join(' | ');
  results.push({ name, ok, ms, tail });
  console.log(`[${ok ? 'OK ' : 'FAIL'}] ${name.padEnd(10)} ${String(ms).padStart(5)}ms  ${ok ? tail.slice(0, 100) : ''}`);
  if (!ok) {
    console.log('  ↳ tail:');
    for (const line of (r.stdout + r.stderr).split('\n').slice(-8)) {
      if (line.trim()) console.log('     ', line);
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log('\n=== SUMMARY ===');
console.log(`  ${results.length - failed.length} / ${results.length} engines green`);
if (failed.length) {
  console.log('  failures:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
