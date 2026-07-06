#!/usr/bin/env node
/**
 * Pack the contents of `engine-artifacts/` into per-asset tar.gz archives,
 * write a `checksums.json` manifest, and stage everything under `release/`
 * ready to attach to a GitHub Release.
 *
 *   node scripts/pack-release.mjs [--out release] [--version v0.1.0]
 *
 * Output layout (release/):
 *   pdflatex-emscripten.tar.gz       — pdflatex/{js,wasm}
 *   xelatex-emscripten.tar.gz        — xelatex/{js,wasm}
 *   lualatex-emscripten.tar.gz       — lualatex/{js,wasm}
 *   bibtexu-emscripten.tar.gz        — bibtexu/{js,wasm}
 *   xdvipdfmx-emscripten.tar.gz      — xdvipdfmx/{js,wasm}
 *   makeindex-emscripten.tar.gz      — makeindex/{js,wasm}
 *   pdflatex-wasi.tar.gz             — pdflatex/wasi/*.wasm (when present)
 *   icudt78l.dat.gz                  — ICU data (single gzipped file)
 *   texmf-core.tar.gz                — optional bundled TDS (when present)
 *   checksums.json                   — { version, generatedAt, assets: { name: { size, sha256 } } }
 *
 * Tar format is a minimal USTAR writer (no native dep, identical bytes on
 * every host). All entries inside a per-engine archive are stored under that
 * engine's name so consumers can untar straight into `<dest>/`.
 */

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync, statSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
  rm,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const ENGINES = [
  'pdflatex',
  'xelatex',
  'lualatex',
  'bibtexu',
  'xdvipdfmx',
  'makeindex',
  // biber's dir also carries biber-vfs.tar.gz (the Perl runtime tree) —
  // packed into the same per-engine archive automatically.
  'biber',
];

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'release' },
      version: { type: 'string', default: '' },
      artifacts: { type: 'string', default: 'engine-artifacts' },
    },
  });

  const artifactsDir = resolve(ROOT, values.artifacts);
  const outDir = resolve(ROOT, values.out);

  if (!existsSync(artifactsDir)) {
    console.error(
      `pack-release: ${artifactsDir} does not exist. Run \`npm run engines:build\` first ` +
        `or copy the engine outputs into ./engine-artifacts/.`,
    );
    process.exit(1);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const version = values.version || (await packageVersion());
  const assets = {};

  for (const engine of ENGINES) {
    for (const target of ['emscripten', 'wasi']) {
      const engineDir = join(artifactsDir, engine, target);
      if (!existsSync(engineDir)) continue;
      const files = await collectFiles(engineDir);
      if (files.length === 0) continue;
      // LICENSE promises attribution inside every engine artifact bundle.
      files.push({ rel: 'NOTICE', content: Buffer.from(noticeText(engine), 'utf8') });
      const archive = join(outDir, `${engine}-${target}.tar.gz`);
      await writeTarGz(archive, files, `${engine}/${target}/`);
      assets[`${engine}-${target}.tar.gz`] = await hashAndSize(archive);
      console.log(`packed ${engine}-${target}.tar.gz (${files.length} files)`);
    }
  }

  const icuPath = join(artifactsDir, 'icudt78l.dat');
  if (existsSync(icuPath)) {
    const dest = join(outDir, 'icudt78l.dat.gz');
    await gzipFile(icuPath, dest);
    assets['icudt78l.dat.gz'] = await hashAndSize(dest);
    console.log('packed icudt78l.dat.gz');
  }

  // Optional bundled TDS — only included if the local tree exists. Don't
  // fail when missing; most consumers will fetch on demand.
  const texmfDir = join(artifactsDir, 'texmf');
  if (existsSync(texmfDir) && statSync(texmfDir).isDirectory()) {
    const files = await collectFiles(texmfDir);
    if (files.length > 0) {
      const dest = join(outDir, 'texmf-core.tar.gz');
      await writeTarGz(dest, files, 'texmf/');
      assets['texmf-core.tar.gz'] = await hashAndSize(dest);
      console.log(`packed texmf-core.tar.gz (${files.length} files)`);
    }
  }

  const checksums = {
    version,
    generatedAt: new Date().toISOString(),
    assets,
  };
  await writeFile(
    join(outDir, 'checksums.json'),
    JSON.stringify(checksums, null, 2),
  );
  console.log(
    `wrote ${Object.keys(assets).length} archives + checksums.json to ${relative(ROOT, outDir)}/`,
  );
}

async function packageVersion() {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  return `v${pkg.version}`;
}

async function collectFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const name of await readdir(d)) {
      const full = join(d, name);
      const st = await stat(full);
      if (st.isDirectory()) await walk(full);
      else if (st.isFile()) out.push({ abs: full, rel: relative(dir, full) });
    }
  }
  await walk(dir);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

async function hashAndSize(path) {
  const bytes = await readFile(path);
  return {
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function gzipFile(srcPath, dstPath) {
  await mkdir(dirname(dstPath), { recursive: true });
  const { createWriteStream } = await import('node:fs');
  await pipeline(createReadStream(srcPath), createGzip({ level: 9 }), createWriteStream(dstPath));
}

function noticeText(component) {
  return (
    `${component} — compiled to WebAssembly from TeX Live sources\n` +
    `(https://tug.org/texlive/, github.com/TeX-Live/texlive-source).\n\n` +
    `The binary in this archive is a derived work of TeX Live and retains\n` +
    `its upstream licenses (predominantly LPPL, GPL family, and\n` +
    `engine-specific terms). See LICENSE.TL in the TeX Live source tree\n` +
    `for the full per-component breakdown. The texlive-wasm wrapper\n` +
    `library and build scripts are MIT-licensed.\n`
  );
}

async function writeTarGz(dstPath, files, prefix) {
  await mkdir(dirname(dstPath), { recursive: true });
  const { createWriteStream } = await import('node:fs');
  async function* generate() {
    for (const f of files) {
      const data = f.content ?? (await readFile(f.abs));
      yield ustarHeader(prefix + f.rel.replaceAll('\\', '/'), data.length);
      yield data;
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) yield Buffer.alloc(pad);
    }
    yield Buffer.alloc(1024); // two empty 512-byte blocks
  }
  await pipeline(Readable.from(generate()), createGzip({ level: 9 }), createWriteStream(dstPath));
}

function ustarHeader(path, size) {
  const buf = Buffer.alloc(512);
  const { prefix, name } = splitUstarPath(path);
  buf.write(name, 0, 100);
  writeOctal(buf, 100, 8, 0o644);              // mode
  writeOctal(buf, 108, 8, 0);                  // uid
  writeOctal(buf, 116, 8, 0);                  // gid
  writeOctal(buf, 124, 12, size);              // size
  writeOctal(buf, 136, 12, 0);                 // mtime — zero for reproducible bytes
  buf.fill(0x20, 148, 156);                    // checksum placeholder (spaces)
  buf[156] = 0x30;                             // typeflag '0' regular file
  buf.write('ustar\0', 257, 6);                // magic
  buf.write('00', 263, 2);                     // version
  if (prefix) buf.write(prefix, 345, 155);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  writeOctal(buf, 148, 7, sum);
  buf[155] = 0x20; // checksum terminator is NUL + space per POSIX convention
  return buf;
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { prefix: '', name: path };
  // Split on the last '/' that leaves name ≤ 100 and prefix ≤ 155.
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i] !== '/') continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { prefix, name };
    }
  }
  throw new Error(`pack-release: path too long for USTAR (${path})`);
}

function writeOctal(buf, offset, len, value) {
  const str = value.toString(8).padStart(len - 1, '0');
  buf.write(str + '\0', offset, len);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
