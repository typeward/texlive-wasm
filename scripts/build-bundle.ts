#!/usr/bin/env tsx
/**
 * build-bundle.ts
 *
 * Pack the TDS tree into two brotli-compressed tarballs:
 *   - core-<version>.tar.br  (just the core-tier files, ~20 MB)
 *   - full-<version>.tar.br  (core + full tiers, ~120 MB)
 *
 * Reads tex-packages.json produced by build-manifest.ts to know what goes
 * where. The resulting tarballs ship via the manifest's coreBundleUrl /
 * fullBundleUrl pointers.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { createBrotliCompress, constants as zlibC } from 'node:zlib';
import { spawn } from 'node:child_process';

interface ManifestEntry {
  sha256: string;
  size: number;
  tier: 'core' | 'full' | 'cdn';
  package: string | null;
}

interface Manifest {
  schema: 1;
  version: string;
  files: Record<string, ManifestEntry>;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      manifest: { type: 'string', default: 'dist/tex-packages.json' },
      tds: { type: 'string', default: 'engine/source/texlive-source/build/output/texmf-dist' },
      out: { type: 'string', default: 'dist' },
      tier: { type: 'string', default: 'both' }, // 'core' | 'full' | 'both'
    },
  });

  const manifestPath = resolve(values.manifest!);
  const manifest: Manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const tdsRoot = resolve(values.tds!);

  const tiers: Array<'core' | 'full'> =
    values.tier === 'core' ? ['core'] : values.tier === 'full' ? ['full'] : ['core', 'full'];

  for (const tier of tiers) {
    // For 'full', include both 'core' and 'full' entries (full is a superset).
    const include = (e: ManifestEntry) =>
      tier === 'core' ? e.tier === 'core' : e.tier === 'core' || e.tier === 'full';
    const paths = Object.entries(manifest.files)
      .filter(([, e]) => include(e))
      .map(([p]) => p);
    const outPath = resolve(values.out!, `${tier}-${manifest.version}.tar.br`);
    await mkdir(dirname(outPath), { recursive: true });
    await buildTarBrotli(tdsRoot, paths, outPath);
    console.log(`Wrote ${outPath} (${paths.length} files)`);
  }
}

async function buildTarBrotli(tdsRoot: string, paths: string[], outPath: string): Promise<void> {
  // We shell out to `tar` because Node's built-in tar package is heavyweight
  // and not in the std lib. Paths arrive via -T (file-list) for portability.
  const fileList = paths.join('\n');
  const tar = spawn('tar', ['-c', '-C', tdsRoot, '-T', '-', '--null', '--no-recursion'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  // Write null-terminated path list.
  const nulList = paths.map((p) => p).join('\0') + '\0';
  void fileList; // unused; we use null-terminated list
  tar.stdin.write(nulList);
  tar.stdin.end();

  const brotli = createBrotliCompress({
    params: {
      [zlibC.BROTLI_PARAM_QUALITY]: 11,
      [zlibC.BROTLI_PARAM_LGWIN]: 24,
    },
  });

  await pipeline(tar.stdout, brotli, createWriteStream(outPath));
}

// Round-trip sanity helper: returns the SHA-256 of a file path. Not invoked by
// default; used by tests.
export async function fileSha256(path: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  return new Promise((res, rej) => {
    createReadStream(path)
      .on('data', (chunk) => h.update(chunk))
      .on('error', rej)
      .on('end', () => res(h.digest('hex')));
  });
}

// Use join to avoid an "unused import" warning until we expand the script.
void join;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
