#!/usr/bin/env node
/**
 * smoke-wasi.mjs — instantiate the WASI build of pdflatex under Node's
 * built-in node:wasi WASI runtime.
 *
 * Goal of Phase 2 #2 is to verify the wasi-sdk build loads, instantiates,
 * and at least reaches main(). Full end-to-end LaTeX compile would also
 * need a populated TDS mounted via WASI preopens, which we can do later.
 */
import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';
import { argv0 } from 'node:process';

const WASM = new URL('../engine/build/pdflatex/wasi/pdflatex.wasm', import.meta.url).pathname;

const wasi = new WASI({
  version: 'preview1',
  args: ['pdflatex', '--version'],
  env: {},
  preopens: {},
});

const bytes = readFileSync(WASM);
console.log(`[smoke-wasi] loading ${bytes.length} bytes`);
const mod = await WebAssembly.compile(bytes);
const imports = wasi.getImportObject();
const instance = await WebAssembly.instantiate(mod, imports);

try {
  const code = wasi.start(instance);
  console.log(`[smoke-wasi] exited with code ${code ?? 0}`);
} catch (e) {
  console.error('[smoke-wasi] runtime error:', e.message);
  process.exit(1);
}
