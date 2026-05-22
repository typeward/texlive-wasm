/**
 * SyncTeX — bidirectional source↔PDF lookup.
 *
 * Forward: (sourceFile, line) → list of PDF rectangles.
 * Reverse: (page, x, y) → list of source locations.
 *
 * Implementation note: the .synctex.gz format is a small text format that
 * SyncTeX's reference parser is ~2KB of code. For v1 we ship a JS-only
 * implementation. If perf turns out to be a problem we'll cross-compile the C
 * `synctex` parser to its own `synctex.wasm` and swap it in transparently.
 */

import { strFromU8, gunzip } from './fflate-shim';

export interface SynctexForwardHit {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SynctexReverseHit {
  file: string;
  line: number;
  column: number;
}

export interface SynctexLookup {
  forward(file: string, line: number, column?: number): SynctexForwardHit[];
  reverse(page: number, x: number, y: number): SynctexReverseHit[];
  /** All input files referenced in the synctex index. */
  files(): string[];
}

/** Parse a `.synctex.gz` (or already-decompressed `.synctex`) buffer. */
export async function createSynctex(bytes: Uint8Array): Promise<SynctexLookup> {
  const decompressed = isGzip(bytes) ? await gunzip(bytes) : bytes;
  const text = strFromU8(decompressed);
  const parsed = parseSynctex(text);

  return {
    forward(_file, _line, _column) {
      // TODO(phase 4): implement forward lookup using parsed.records.
      return [];
    },
    reverse(_page, _x, _y) {
      // TODO(phase 4): implement reverse lookup using parsed.records.
      return [];
    },
    files() {
      return Object.values(parsed.inputs);
    },
  };
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

interface ParsedSynctex {
  /** input id → filename */
  inputs: Record<string, string>;
  /** raw records for now; structured into a tree in Phase 4 */
  records: string[];
}

function parseSynctex(text: string): ParsedSynctex {
  const inputs: Record<string, string> = {};
  const records: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('Input:')) {
      // Input:<id>:<filename>
      const rest = line.slice('Input:'.length);
      const colon = rest.indexOf(':');
      if (colon > 0) {
        const id = rest.slice(0, colon);
        const name = rest.slice(colon + 1);
        inputs[id] = name;
      }
    } else if (line.length > 0) {
      records.push(line);
    }
  }
  return { inputs, records };
}
