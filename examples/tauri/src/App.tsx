import { createSignal, onMount, Show } from 'solid-js';
import { PdfLatex, isTauri, type RunResult } from './texlive';

const DEFAULT_SRC = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
Hello from \\TeX{}Live 2026 on WebAssembly --- shipped inside a Tauri app.

\\[
  e^{i\\pi} + 1 = 0
\\]
\\end{document}
`;

export function App() {
  const [source, setSource] = createSignal(DEFAULT_SRC);
  const [pdfUrl, setPdfUrl] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal('idle');
  const [log, setLog] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [runtime, setRuntime] = createSignal<'web' | 'tauri'>('web');
  let engine: PdfLatex | null = null;

  onMount(() => {
    setRuntime(isTauri() ? 'tauri' : 'web');
  });

  async function compile() {
    setBusy(true);
    setStatus('preparing engine...');
    setLog('');
    setPdfUrl(null);
    try {
      if (!engine) {
        engine = new PdfLatex({
          enginePath: '/texlive-wasm/pdflatex/emscripten/pdflatex.wasm',
        });
      }
      setStatus('compiling...');
      const t0 = performance.now();
      const result: RunResult = await engine.compile({
        mainTex: 'main.tex',
        files: [{ path: 'main.tex', content: source() }],
      });
      const dt = performance.now() - t0;

      setLog(result.log || result.stdout || '(no log)');

      const pdf = result.outputs.get('main.pdf');
      if (pdf) {
        // Copy into a fresh ArrayBuffer-backed view: TS 5.7+ dom types reject
        // Uint8Array<ArrayBufferLike> as a BlobPart.
        const blob = new Blob([new Uint8Array(pdf)], { type: 'application/pdf' });
        setPdfUrl(URL.createObjectURL(blob));
        setStatus(`done in ${dt.toFixed(0)} ms — exit ${result.exitCode}`);
      } else {
        setStatus(`failed (exit ${result.exitCode}, ${dt.toFixed(0)} ms) — see log`);
      }
    } catch (err) {
      setStatus('error: ' + (err as Error).message);
      setLog((err as Error).stack ?? String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', height: '100vh' }}>
      <div style={{ padding: '16px', display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
        <header style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <strong>texlive-wasm</strong>
          <span style={{ 'font-size': '12px', opacity: 0.7 }}>
            running in <code>{runtime()}</code>
          </span>
          <button onClick={compile} disabled={busy()} style={{ 'margin-left': 'auto' }}>
            {busy() ? 'compiling…' : 'Compile'}
          </button>
        </header>
        <textarea
          value={source()}
          onInput={(e) => setSource(e.currentTarget.value)}
          style={{ flex: '1', 'font-family': 'monospace', 'font-size': '13px' }}
        />
        <div style={{ 'font-size': '12px', color: '#555' }}>{status()}</div>
        <Show when={log()}>
          <pre
            style={{
              flex: '0 0 25%',
              overflow: 'auto',
              'font-size': '11px',
              background: '#111',
              color: '#eee',
              padding: '8px',
              margin: 0,
            }}
          >
            {log()}
          </pre>
        </Show>
      </div>
      <div style={{ background: '#222' }}>
        <Show when={pdfUrl()} fallback={<Placeholder />}>
          <iframe
            src={pdfUrl()!}
            style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
          />
        </Show>
      </div>
    </div>
  );
}

function Placeholder() {
  return (
    <div style={{ color: '#aaa', padding: '24px', 'font-family': 'system-ui' }}>
      Click <strong>Compile</strong> to render the document.
    </div>
  );
}
