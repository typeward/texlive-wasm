/**
 * Tiny streaming tar parser (POSIX ustar format).
 *
 * Used by BundleFS to extract a `.tar` (or brotli/gzip-wrapped tar) into a
 * Map<path, Uint8Array> for MEMFS upload.
 *
 * Why hand-rolled: tar is dead simple (512-byte fixed headers) and bringing
 * in fflate/tarjs/etc. would add a dep just for this single use case.
 */

export interface TarEntry {
  path: string;
  content: Uint8Array;
  type: 'file' | 'dir' | 'other';
}

/** Parse a tar archive into a list of entries. */
export function untar(bytes: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  const decoder = new TextDecoder();
  let offset = 0;
  // POSIX ustar prefix support (long pathnames).
  let pendingLongName: string | null = null;

  while (offset + 512 <= bytes.length) {
    const block = bytes.subarray(offset, offset + 512);
    if (isAllZero(block)) {
      // Trailing zero block(s) signal end of archive.
      break;
    }

    const name = readCString(block, 0, 100);
    const size = parseOctal(block, 124, 12);
    const typeflag = String.fromCharCode(block[156] ?? 0);
    const prefix = readCString(block, 345, 155);
    const fullPath = pendingLongName ?? (prefix ? prefix + '/' + name : name);
    pendingLongName = null;

    offset += 512;
    const contentBlocks = Math.ceil(size / 512);
    const content = bytes.subarray(offset, offset + size);
    offset += contentBlocks * 512;

    if (typeflag === 'L') {
      // GNU long-name extension: next entry's name is this content (NUL-terminated).
      pendingLongName = decoder.decode(content).replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') {
      // PAX extended headers — skip; basic ustar fields suffice for our use.
      continue;
    }

    const type: TarEntry['type'] =
      typeflag === '5' ? 'dir' : typeflag === '0' || typeflag === '\0' ? 'file' : 'other';
    out.push({ path: fullPath, content: type === 'file' ? content : new Uint8Array(), type });
  }
  return out;
}

function readCString(block: Uint8Array, start: number, len: number): string {
  let end = start;
  while (end < start + len && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(start, end));
}

function parseOctal(block: Uint8Array, start: number, len: number): number {
  let n = 0;
  for (let i = start; i < start + len; i++) {
    const c = block[i];
    if (c === undefined || c === 0 || c === 0x20) continue;
    if (c < 0x30 || c > 0x37) break;
    n = n * 8 + (c - 0x30);
  }
  return n;
}

function isAllZero(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

/**
 * Decompress a gzip- or brotli-wrapped buffer using native DecompressionStream.
 *
 * `format` may be 'gzip' or 'deflate-raw' or 'br'. Brotli support varies by
 * runtime (Chrome 121+, Firefox 127+, Node 22+); gzip works everywhere since
 * 2023. Caller picks based on what their target supports.
 */
export async function decompress(
  bytes: Uint8Array,
  format: 'gzip' | 'deflate-raw' | 'br',
): Promise<Uint8Array> {
  const Ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (!Ctor) {
    throw new Error(`DecompressionStream not available; can't decompress ${format}`);
  }
  // Copy to ArrayBuffer-backed view (Blob doesn't accept SharedArrayBuffer views).
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  // `br` is a valid CompressionFormat at runtime in Chrome 121+/FF 127+/Node 22+
  // but TS's lib.dom.d.ts only declares 'gzip' | 'deflate' | 'deflate-raw'.
  // We cast — at runtime DecompressionStream throws TypeError if unsupported.
  const stream = new Blob([ab]).stream().pipeThrough(new Ctor(format as CompressionFormat));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
