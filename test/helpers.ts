/** Shared test helpers: a tiny USTAR writer to feed the tar parser. */

export interface TarSpec {
  path: string;
  content?: Uint8Array | string;
  type?: 'file' | 'dir' | 'gnu-long-name' | 'pax';
}

export function buildTar(specs: TarSpec[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const spec of specs) {
    const content =
      typeof spec.content === 'string'
        ? new TextEncoder().encode(spec.content)
        : (spec.content ?? new Uint8Array());
    blocks.push(header(spec.path, content.length, typeflagFor(spec.type ?? 'file')));
    if (content.length > 0) {
      const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
      padded.set(content);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function typeflagFor(type: 'file' | 'dir' | 'gnu-long-name' | 'pax'): number {
  if (type === 'dir') return 0x35; // '5'
  if (type === 'gnu-long-name') return 0x4c; // 'L'
  if (type === 'pax') return 0x78; // 'x'
  return 0x30; // '0'
}

function header(path: string, size: number, typeflag: number): Uint8Array {
  const buf = new Uint8Array(512);
  const enc = new TextEncoder();
  // Split into ustar prefix/name when the path exceeds the 100-byte field.
  let name = path;
  let prefix = '';
  if (enc.encode(path).length > 100) {
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i] !== '/') continue;
      const p = path.slice(0, i);
      const n = path.slice(i + 1);
      if (enc.encode(n).length <= 100 && enc.encode(p).length <= 155) {
        prefix = p;
        name = n;
        break;
      }
    }
  }
  buf.set(enc.encode(name).subarray(0, 100), 0);
  writeOctal(buf, 100, 8, 0o644);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, size);
  writeOctal(buf, 136, 12, 0);
  buf.fill(0x20, 148, 156);
  buf[156] = typeflag;
  buf.set(enc.encode('ustar\0'), 257);
  buf.set(enc.encode('00'), 263);
  if (prefix) buf.set(enc.encode(prefix).subarray(0, 155), 345);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i]!;
  writeOctal(buf, 148, 7, sum);
  buf[155] = 0x20;
  return buf;
}

function writeOctal(buf: Uint8Array, offset: number, len: number, value: number): void {
  const str = value.toString(8).padStart(len - 1, '0') + '\0';
  new TextEncoder().encodeInto(str, buf.subarray(offset, offset + len));
}

/** PAX extended-header body: "<len> <key>=<value>\n" records. */
export function paxBody(records: Record<string, string>): string {
  let out = '';
  for (const [key, value] of Object.entries(records)) {
    const payload = ` ${key}=${value}\n`;
    // len counts itself; iterate until the digit count stabilizes.
    let len = payload.length + 1;
    while (String(len).length + payload.length !== len) {
      len = String(len).length + payload.length;
    }
    out += `${len}${payload}`;
  }
  return out;
}
