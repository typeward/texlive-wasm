#!/usr/bin/env node
/**
 * Make sure engine artifacts + TDS are available at examples/tauri/public/texlive-wasm/
 * before `tauri dev` / `tauri build` runs.
 *
 * Preference order (cheapest first):
 *   1. Already exists at the target path → no-op.
 *   2. Local `engine-artifacts/` tree (developer build)   → symlink/copy in.
 *   3. Local `release/*.tar.gz` (just-packed)             → extract.
 *   4. GitHub release for the current package.json tag    → download + extract
 *      (delegated to scripts/cli.cjs download-assets).
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TARGET = resolve(ROOT, 'examples/tauri/public/texlive-wasm');

function looksPopulated(dir) {
  if (!existsSync(dir)) return false;
  // Require at least one engine .wasm to consider it populated.
  let found = false;
  function walk(d) {
    if (found) return;
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.wasm')) found = true;
      if (found) return;
    }
  }
  walk(dir);
  return found;
}

function copyEngineArtifacts() {
  const src = resolve(ROOT, 'engine-artifacts');
  if (!existsSync(src)) return false;
  mkdirSync(TARGET, { recursive: true });
  // Mirror engine-artifacts/<engine>/<target>/ under TARGET/<engine>/<target>/.
  for (const engine of readdirSync(src)) {
    const enginePath = join(src, engine);
    if (!statSync(enginePath).isDirectory()) {
      // top-level files like icudt78l.dat
      cpSync(enginePath, join(TARGET, engine));
      continue;
    }
    cpSync(enginePath, join(TARGET, engine), { recursive: true });
  }
  console.log(`[ensure-assets] copied engine-artifacts → ${TARGET}`);
  return true;
}

function downloadFromRelease() {
  console.log('[ensure-assets] no local artifacts found; downloading from GitHub release...');
  const cli = resolve(ROOT, 'scripts/cli.cjs');
  const r = spawnSync(process.execPath, [cli, 'download-assets', TARGET], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    throw new Error(
      'ensure-assets: download-assets failed. ' +
        'Either build the engines locally (`npm run engines:build`) ' +
        'or publish a GitHub release matching the package.json version.',
    );
  }
}

if (looksPopulated(TARGET)) {
  console.log(`[ensure-assets] ${TARGET} already populated, skipping.`);
} else if (copyEngineArtifacts()) {
  // done
} else {
  downloadFromRelease();
}
