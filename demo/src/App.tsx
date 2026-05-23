import { createSignal, onMount } from 'solid-js';
import { PdfViewer } from './PdfViewer';

const DEFAULT_DOC = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
Hello from \\TeX{}Live 2026 on WebAssembly!

\\begin{equation}
  E = mc^2
\\end{equation}
\\end{document}
`;

interface EngineHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FS: any;
  callMain(args: string[]): number;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  _malloc(n: number): number;
  print?: (t: string) => void;
  printErr?: (t: string) => void;
}

interface TarEntry {
  path: string;
  content: Uint8Array;
}

function untar(bytes: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  const decoder = new TextDecoder();
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= bytes.length) {
    const block = bytes.subarray(off, off + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++)
      if (block[i] !== 0) {
        allZero = false;
        break;
      }
    if (allZero) break;
    const name = readCString(block, 0, 100);
    const size = parseOctal(block, 124, 12);
    const type = String.fromCharCode(block[156] ?? 0);
    const prefix = readCString(block, 345, 155);
    const full = longName ?? (prefix ? prefix + '/' + name : name);
    longName = null;
    off += 512;
    const content = bytes.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = decoder.decode(content).replace(/\0+$/, '');
      continue;
    }
    if (type === '0' || type === '\0') out.push({ path: full, content });
  }
  return out;
}

function readCString(b: Uint8Array, s: number, l: number): string {
  let e = s;
  while (e < s + l && b[e] !== 0) e++;
  return new TextDecoder().decode(b.subarray(s, e));
}

function parseOctal(b: Uint8Array, s: number, l: number): number {
  let n = 0;
  for (let i = s; i < s + l; i++) {
    const c = b[i];
    if (c === undefined || c === 0 || c === 0x20) continue;
    if (c < 0x30 || c > 0x37) break;
    n = n * 8 + (c - 0x30);
  }
  return n;
}

function mkdirP(FS: EngineHandle['FS'], path: string): void {
  if (!path || path === '/' || FS.analyzePath(path).exists) return;
  const i = path.lastIndexOf('/');
  mkdirP(FS, i <= 0 ? '/' : path.slice(0, i));
  FS.mkdir(path);
}

export function App() {
  const [source, setSource] = createSignal(DEFAULT_DOC);
  const [pdfUrl, setPdfUrl] = createSignal<string | null>(null);
  const [log, setLog] = createSignal<string>('');
  const [status, setStatus] = createSignal<string>('idle');
  const [busy, setBusy] = createSignal(false);
  let cachedEngine: EngineHandle | null = null;

  async function loadEngine(): Promise<EngineHandle> {
    if (cachedEngine) return cachedEngine;

    setStatus('loading engine (pdflatex.wasm ~1.3 MB)...');
    const url = '/core/pdflatex/emscripten/pdflatex.js';
    const factory = (
      (await import(/* @vite-ignore */ url)) as {
        default: (opts: object) => Promise<EngineHandle>;
      }
    ).default;
    const Module = await factory({
      noInitialRun: true,
      thisProgram: '/bin/pdflatex',
      print: () => {},
      printErr: () => {},
    });

    setStatus('loading TDS bundle (~18 MB brotli)...');
    const t0 = performance.now();
    // Fetches the raw .tar path; the dev server upgrades it to brotli or gzip
    // via Content-Encoding negotiation, and the browser decompresses
    // transparently. Saves ~10 MB over the manual gzip path.
    let tarBytes: Uint8Array;
    const resp = await fetch('/core/texmf.tar');
    if (resp.ok) {
      tarBytes = new Uint8Array(await resp.arrayBuffer());
    } else {
      // Fallback for static hosts that don't pre-compress.
      const fallback = await fetch('/core/texmf.tar.gz');
      if (!fallback.ok) throw new Error(`TDS bundle: HTTP ${fallback.status}`);
      const compressed = new Uint8Array(await fallback.arrayBuffer());
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([compressed.buffer as ArrayBuffer]).stream().pipeThrough(ds);
      tarBytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    setStatus(`extracting TDS (${(tarBytes.length / 1024 / 1024).toFixed(1)} MB)...`);
    const entries = untar(tarBytes);
    let count = 0;
    for (const entry of entries) {
      const path = entry.path.startsWith('texmf/') ? entry.path.slice(6) : entry.path;
      if (!path) continue;
      const abs = `/texmf-dist/${path}`;
      mkdirP(Module.FS, abs.slice(0, abs.lastIndexOf('/')) || '/');
      try {
        Module.FS.writeFile(abs, entry.content);
        count++;
      } catch {}
    }
    setStatus(`TDS loaded: ${count} files in ${(performance.now() - t0).toFixed(0)}ms`);

    Module.FS.mkdir('/bin');
    Module.FS.writeFile('/bin/pdflatex', new Uint8Array());
    Module.FS.mkdir('/project');

    cachedEngine = Module;
    return Module;
  }

  async function compile() {
    setBusy(true);
    setLog('');
    setPdfUrl(null);
    try {
      const Module = await loadEngine();
      setStatus('compiling...');

      // Clear and populate /project
      try {
        for (const name of Module.FS.readdir('/project')) {
          if (name === '.' || name === '..') continue;
          Module.FS.unlink('/project/' + name);
        }
      } catch {}
      Module.FS.writeFile('/project/main.tex', source());
      Module.FS.chdir('/project');

      let stdout = '';
      Module.print = (t: string) => {
        stdout += t + '\n';
      };
      Module.printErr = (t: string) => {
        stdout += t + '\n';
      };

      const t0 = performance.now();
      let exitCode = 0;
      try {
        exitCode = Module.callMain([
          '-interaction=nonstopmode',
          '-fmt=/texmf-dist/web2c/pdftex/pdflatex.fmt',
          '-cnf-line=TEXMFCNF=/texmf-dist/web2c',
          '-cnf-line=TEXMF=/texmf-dist',
          '-cnf-line=TEXMFDIST=/texmf-dist',
          '-cnf-line=TEXINPUTS=.;/texmf-dist/tex//',
          '-cnf-line=TFMFONTS=/texmf-dist/fonts/tfm//',
          '-cnf-line=VFFONTS=/texmf-dist/fonts/vf//',
          '-cnf-line=T1FONTS=/texmf-dist/fonts/type1//',
          '-cnf-line=ENCFONTS=/texmf-dist/fonts/enc//',
          '-cnf-line=TEXFONTMAPS=/texmf-dist/fonts/map//',
          'main.tex',
        ]);
      } catch (e) {
        exitCode = (e as { status?: number })?.status ?? -1;
      }
      const dur = performance.now() - t0;
      setStatus(`exit=${exitCode}, ${dur.toFixed(0)} ms`);

      if (Module.FS.analyzePath('/project/main.pdf').exists) {
        const pdf = Module.FS.readFile('/project/main.pdf') as Uint8Array;
        const blob = new Blob([pdf.buffer as ArrayBuffer], { type: 'application/pdf' });
        if (pdfUrl()) URL.revokeObjectURL(pdfUrl()!);
        setPdfUrl(URL.createObjectURL(blob));
        setLog(stdout.split('\n').slice(-30).join('\n'));
      } else {
        setLog(stdout.split('\n').slice(-40).join('\n'));
      }
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
      setLog(`${(err as Error).stack ?? err}`);
    } finally {
      setBusy(false);
    }
  }

  onMount(() => {
    setStatus('ready — click Compile to load engine + compile');
  });

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        'font-family': 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', padding: '8px' }}>
        <div
          style={{
            'font-size': '12px',
            color: '#666',
            margin: '0 0 4px 4px',
          }}
        >
          {status()}
        </div>
        <textarea
          style={{
            flex: '1',
            'font-family': '"SF Mono", Menlo, Consolas, monospace',
            'font-size': '13px',
            border: '1px solid #ddd',
            padding: '8px',
          }}
          value={source()}
          onInput={(e) => setSource(e.currentTarget.value)}
        />
        <button
          onClick={compile}
          disabled={busy()}
          style={{
            'margin-top': '8px',
            padding: '8px 16px',
            'font-size': '14px',
            cursor: busy() ? 'wait' : 'pointer',
          }}
        >
          {busy() ? 'Working…' : 'Compile (pdflatex)'}
        </button>
        <pre
          style={{
            'max-height': '180px',
            overflow: 'auto',
            background: '#f7f7f7',
            padding: '8px',
            margin: '8px 0 0 0',
            'font-size': '11px',
            'white-space': 'pre-wrap',
            border: '1px solid #e0e0e0',
          }}
        >
          {log()}
        </pre>
      </div>
      <div style={{ flex: '1', 'border-left': '1px solid #ccc' }}>
        <PdfViewer pdfUrl={pdfUrl()} />
      </div>
    </div>
  );
}
