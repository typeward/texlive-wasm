#!/usr/bin/env node
/**
 * gen-cpan-lock.mjs — regenerate scripts/biber/cpan-lock.txt.
 *
 *   node gen-cpan-lock.mjs <cpanm-lib-tree> [out-file]
 *
 * <cpanm-lib-tree> is any tree written by `cpanm -L <dir>` (or the perl
 * prefix of a finished build — the .meta/ dirs survive into biber-vfs.tar.gz).
 * Every dist cpanm installed leaves a .meta/<dist>/install.json carrying the
 * exact CPAN `pathname` it came from, plus MYMETA.json with its prereqs.
 *
 * From those we emit, for each dist:
 *   <sha256>  <author-path>
 * with the sha256 taken from the author's PAUSE-signed CHECKSUMS file (the
 * same bytes CPAN publishes; never computed from a local guess), and the
 * lines ordered so that every dist appears after the dists it depends on —
 * the pinned install feeds cpanm local tarballs in exactly this order with
 * `--mirror-only`, so an out-of-order or incomplete lock fails the build
 * instead of silently resolving an unpinned dist off the network.
 *
 * Maintainer-run (needs network). Review the diff before committing: this is
 * the only point where unpinned CPAN metadata can enter the build.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
const outFile = process.argv[3] ?? fileURLToPath(new URL('./cpan-lock.txt', import.meta.url));
if (!root) {
  console.error('usage: gen-cpan-lock.mjs <cpanm-lib-tree> [out-file]');
  process.exit(2);
}

function findMetaDirs(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (name === '.meta') {
      for (const dist of readdirSync(full)) acc.push(join(full, dist));
    } else {
      findMetaDirs(full, acc);
    }
  }
  return acc;
}

const dists = new Map(); // dist-with-version -> { pathname, deps: Set }
const moduleToDist = new Map();

for (const meta of findMetaDirs(root)) {
  let install;
  try {
    install = JSON.parse(readFileSync(join(meta, 'install.json'), 'utf8'));
  } catch {
    continue;
  }
  // App::cpanminus is the bootstrap (pinned in spike-build.sh itself) and
  // must not be installed through the locked mirror.
  if (install.name === 'App-cpanminus') continue;
  const key = `${install.name}-${install.version}`;
  dists.set(key, { pathname: install.pathname, meta, deps: new Set() });
  for (const mod of Object.keys(install.provides ?? {})) moduleToDist.set(mod, key);
}
if (!dists.size) {
  console.error(`no cpanm .meta/*/install.json found under ${root}`);
  process.exit(1);
}

for (const [key, dist] of dists) {
  let mymeta;
  try {
    mymeta = JSON.parse(readFileSync(join(dist.meta, 'MYMETA.json'), 'utf8'));
  } catch {
    continue;
  }
  // cpanm installs configure/build/runtime AND test prereqs (--notest only
  // skips running the tests) — all four phases are edges in the install graph.
  for (const phase of ['configure', 'build', 'runtime', 'test']) {
    for (const rel of ['requires', 'recommends']) {
      for (const mod of Object.keys(mymeta.prereqs?.[phase]?.[rel] ?? {})) {
        const dep = moduleToDist.get(mod);
        if (dep && dep !== key) dist.deps.add(dep);
      }
    }
  }
}

// Kahn topological sort; alphabetical among ready nodes so the lock is stable.
const order = [];
const pending = new Map([...dists].map(([k, v]) => [k, new Set(v.deps)]));
while (pending.size) {
  const ready = [...pending]
    .filter(([, deps]) => [...deps].every((d) => !pending.has(d)))
    .map(([k]) => k)
    .sort();
  if (!ready.length) {
    console.error(`dependency cycle among: ${[...pending.keys()].join(', ')}`);
    process.exit(1);
  }
  for (const k of ready) {
    order.push(k);
    pending.delete(k);
  }
}

// sha256 from the author's PAUSE CHECKSUMS (one fetch per author dir).
const checksums = new Map();
for (const key of order) {
  const path = dists.get(key).pathname;
  const authorDir = path.split('/').slice(0, 3).join('/');
  if (checksums.has(path)) continue;
  if (!checksums.has(authorDir)) {
    const url = `https://cpan.metacpan.org/authors/id/${authorDir}/CHECKSUMS`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`CHECKSUMS fetch failed: ${url} (${res.status})`);
      process.exit(1);
    }
    const text = await res.text();
    const entry = /'([^']+\.tar\.gz)'\s*=>\s*\{([\s\S]*?)\n\s*\}/g;
    let m;
    while ((m = entry.exec(text))) {
      const sha = /'sha256'\s*=>\s*'([0-9a-f]{64})'/.exec(m[2]);
      if (sha) checksums.set(`${authorDir}/${m[1]}`, sha[1]);
    }
    checksums.set(authorDir, true);
  }
  if (!checksums.has(path)) {
    console.error(`no sha256 in CHECKSUMS for ${path} (dist removed from CPAN?)`);
    process.exit(1);
  }
}

const lines = [
  '# cpan-lock.txt — the complete pure-perl dependency closure of biber,',
  '# pinned by sha256. Generated by gen-cpan-lock.mjs; do not hand-edit.',
  '#',
  '# Format: <sha256>  <CPAN author path under authors/id/>',
  '# Order:  dependency order — cpanm installs these tarballs top to bottom',
  '#         from a local mirror with --mirror-only, so every prereq must',
  '#         already be installed by the time its dependent is reached.',
  '#',
  '# Regenerate (maintainer, inside the builder container, needs network):',
  '#   bash scripts/biber/spike-build.sh cpan-lock',
  '',
  ...order.map((key) => `${checksums.get(dists.get(key).pathname)}  ${dists.get(key).pathname}`),
  '',
];
writeFileSync(outFile, lines.join('\n'));
console.log(`wrote ${outFile}: ${order.length} dists`);
