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

export interface UntarOptions {
  /**
   * Ceiling on the number of entries. The full TeX tree is ~180k files, so
   * anything past this is not a TDS — it is an archive built to make us
   * allocate. Default: MAX_TAR_ENTRIES.
   */
  maxEntries?: number;
}

/**
 * Ceiling on the entry count of a single archive. The full TL 2026 tree is
 * roughly 180k files; the bundles we publish are far smaller.
 */
export const MAX_TAR_ENTRIES = 250_000;

/**
 * Parse a tar archive into a list of entries.
 *
 * A malformed or hostile archive is an error, not a shorter list: a header
 * whose declared size runs past the end of the buffer, or an entry count no
 * TDS could have, means the bytes are not the archive we asked for. Entry
 * NAMES are not judged here — the caller owns the root they unpack into and
 * confines them with safeRelativePath (see vfs/bundlefs.ts).
 */
export function untar(bytes: Uint8Array, options: UntarOptions = {}): TarEntry[] {
  const maxEntries = options.maxEntries ?? MAX_TAR_ENTRIES;
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
    // A size that overruns the buffer means the header is lying (or the
    // download was truncated); subarray() would silently hand back a short
    // read, and the engine would compile with half a file.
    if (size < 0 || !Number.isSafeInteger(size) || offset + size > bytes.length) {
      throw new Error(
        `texlive-wasm: tar entry "${fullPath}" declares ${size} bytes, past the end of the archive`,
      );
    }
    const contentBlocks = Math.ceil(size / 512);
    const content = bytes.subarray(offset, offset + size);
    offset += contentBlocks * 512;

    if (out.length >= maxEntries) {
      throw new Error(
        `texlive-wasm: tar archive has more than ${maxEntries} entries; refusing to continue`,
      );
    }

    if (typeflag === 'L') {
      // GNU long-name extension: next entry's name is this content (NUL-terminated).
      pendingLongName = decoder.decode(content).replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x') {
      // PAX extended header: may carry a `path` record that overrides the
      // (possibly truncated) ustar name of the NEXT entry.
      const paxPath = parsePaxPath(decoder.decode(content));
      if (paxPath) pendingLongName = paxPath;
      continue;
    }
    if (typeflag === 'g') {
      // PAX global header — no per-entry data we care about.
      continue;
    }

    const type: TarEntry['type'] =
      typeflag === '5' ? 'dir' : typeflag === '0' || typeflag === '\0' ? 'file' : 'other';
    out.push({ path: fullPath, content: type === 'file' ? content : new Uint8Array(), type });
  }
  return out;
}

/**
 * PAX extended-header body is a sequence of "<len> <key>=<value>\n" records
 * where <len> counts the whole record in bytes. Returns the `path` value.
 */
function parsePaxPath(body: string): string | null {
  let i = 0;
  while (i < body.length) {
    const space = body.indexOf(' ', i);
    if (space < 0) break;
    const len = Number(body.slice(i, space));
    if (!Number.isFinite(len) || len <= 0) break;
    const record = body.slice(space + 1, i + len);
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') {
      return record.slice(eq + 1).replace(/\n$/, '');
    }
    i += len;
  }
  return null;
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
 * Ceiling on what a single archive may expand to. The full TeX tree is the
 * largest thing we legitimately unpack (~275 MB), so anything past this is a
 * compression bomb or a wrong URL — and on a mobile WebView, unpacking it
 * would take the app down before any JS error surfaced.
 */
export const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

/**
 * Decompress a gzip- or brotli-wrapped buffer using native DecompressionStream.
 *
 * `format` may be 'gzip' or 'deflate-raw' or 'br'. Brotli support varies by
 * runtime (Chrome 121+, Firefox 127+, Node 22+); gzip works everywhere since
 * 2023. Caller picks based on what their target supports.
 *
 * The output is bounded as it streams — checking the size after the fact
 * would mean the bomb has already been allocated.
 */
export async function decompress(
  bytes: Uint8Array,
  format: 'gzip' | 'deflate-raw' | 'br',
  maxBytes: number = MAX_DECOMPRESSED_BYTES,
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
  const stream = new Blob([ab])
    .stream()
    .pipeThrough(new Ctor(format as CompressionFormat))
    .pipeThrough(limitBytes(maxBytes, format));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** Errors the stream as soon as it has produced more than `maxBytes`. */
function limitBytes(maxBytes: number, format: string): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(
          new Error(
            `texlive-wasm: ${format} stream expands past the ${maxBytes}-byte limit; refusing to continue`,
          ),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
}
