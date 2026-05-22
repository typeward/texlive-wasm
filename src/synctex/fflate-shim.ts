/**
 * Minimal gzip decompression helpers.
 *
 * Browsers ≥2023 and Node ≥18 have DecompressionStream natively, which is all
 * we need for `.synctex.gz`. If perf matters later we can swap in fflate
 * (~3KB extra) and use its synchronous decompressSync for tiny blobs.
 */

export function strFromU8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** Async gzip decompress via the platform DecompressionStream. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (!Ctor) {
    throw new Error(
      'DecompressionStream is not available; ship a gzip polyfill or upgrade Node/browser.',
    );
  }
  // Copy into a fresh ArrayBuffer-backed Uint8Array — Blob's BlobPart only
  // accepts views over ArrayBuffer, not SharedArrayBuffer.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const stream = new Blob([ab]).stream().pipeThrough(new Ctor('gzip'));
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}
