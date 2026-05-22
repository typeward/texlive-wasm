import { createSignal, Show } from 'solid-js';
import { latexmk } from 'texlive-wasm';

const DEFAULT_DOC = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
Hello from \\TeX{}live-wasm!

\\begin{equation}
  E = mc^2
\\end{equation}
\\end{document}
`;

export function App() {
  const [source, setSource] = createSignal(DEFAULT_DOC);
  const [pdfUrl, setPdfUrl] = createSignal<string | null>(null);
  const [log, setLog] = createSignal<string>('');
  const [busy, setBusy] = createSignal(false);

  async function compile() {
    setBusy(true);
    setLog('');
    setPdfUrl(null);
    try {
      const result = await latexmk({
        engine: 'pdflatex',
        mainTex: 'main.tex',
        files: [{ path: 'main.tex', content: source() }],
      });
      setLog(result.log || `exit ${result.exitCode}, passes ${result.passes}`);
      if (result.pdf) {
        const blob = new Blob([result.pdf], { type: 'application/pdf' });
        setPdfUrl(URL.createObjectURL(blob));
      }
    } catch (err) {
      setLog(`error: ${(err as Error).message}\n${(err as Error).stack ?? ''}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh', 'font-family': 'system-ui, sans-serif' }}>
      <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', padding: '8px' }}>
        <textarea
          style={{ flex: '1', 'font-family': 'monospace', 'font-size': '13px' }}
          value={source()}
          onInput={(e) => setSource(e.currentTarget.value)}
        />
        <button onClick={compile} disabled={busy()} style={{ 'margin-top': '8px' }}>
          {busy() ? 'Compiling…' : 'Compile (pdflatex)'}
        </button>
        <pre
          style={{
            'max-height': '180px',
            overflow: 'auto',
            'background': '#f4f4f4',
            padding: '8px',
            margin: 0,
            'font-size': '11px',
          }}
        >
          {log()}
        </pre>
      </div>
      <div style={{ flex: '1', 'border-left': '1px solid #ccc' }}>
        <Show when={pdfUrl()} fallback={<div style={{ padding: '16px' }}>No PDF yet.</div>}>
          <iframe src={pdfUrl()!} style={{ width: '100%', height: '100%', border: 0 }} />
        </Show>
      </div>
    </div>
  );
}
