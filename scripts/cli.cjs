#!/usr/bin/env node
/**
 * texlive-wasm CLI — thin dispatcher for the helper commands consumers use.
 *
 *   npx texlive-wasm download-assets [dest]
 *   npx texlive-wasm prepare-resources <out-dir> [--tier core|full]
 *   npx texlive-wasm version
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const args = process.argv.slice(2);
const command = args[0];

function usage() {
  console.log(
    'Usage:\n' +
      '  texlive-wasm download-assets [dest]\n' +
      '  texlive-wasm prepare-resources <out-dir> [--tier core|full]\n' +
      '  texlive-wasm version',
  );
}

async function downloadAssets(dest) {
  const out = path.resolve(dest || './public/texlive-wasm');
  fs.mkdirSync(out, { recursive: true });
  console.error(
    `[texlive-wasm] download-assets is a Phase 2 stub. ` +
      `Place engine .wasm files and tex-packages.json in: ${out}`,
  );
}

async function prepareResources(outDir, opts) {
  const out = path.resolve(outDir);
  fs.mkdirSync(out, { recursive: true });
  const tier = opts.tier || 'full';
  console.error(
    `[texlive-wasm] prepare-resources is a Phase 2 stub. ` +
      `Will unpack the '${tier}' bundle into: ${out}`,
  );
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tier') {
      out.tier = argv[++i];
    }
  }
  return out;
}

(async () => {
  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }
  if (command === 'version') {
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    console.log(pkg.version);
    return;
  }
  if (command === 'download-assets') {
    await downloadAssets(args[1]);
    return;
  }
  if (command === 'prepare-resources') {
    if (!args[1]) {
      console.error('prepare-resources: <out-dir> required');
      process.exit(1);
    }
    await prepareResources(args[1], parseFlags(args.slice(2)));
    return;
  }
  usage();
  process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
