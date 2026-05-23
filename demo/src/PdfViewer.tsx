import { createSignal, onCleanup, createEffect, Show } from 'solid-js';
import * as pdfjs from 'pdfjs-dist';

// Vite resolves `?url` to the asset's served URL.
const workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href;
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface Props {
  pdfUrl: string | null;
}

export function PdfViewer(props: Props) {
  const [doc, setDoc] = createSignal<pdfjs.PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = createSignal(1);
  const [pageCount, setPageCount] = createSignal(0);
  const [scale, setScale] = createSignal(1.25);
  const [error, setError] = createSignal<string | null>(null);
  let canvasRef: HTMLCanvasElement | undefined;

  createEffect(async () => {
    const url = props.pdfUrl;
    if (!url) {
      setDoc(null);
      setError(null);
      return;
    }
    setError(null);
    try {
      const task = pdfjs.getDocument({ url });
      const d = await task.promise;
      setDoc(d);
      setPageCount(d.numPages);
      setPageNum(1);
    } catch (e) {
      setError((e as Error).message);
    }
  });

  createEffect(async () => {
    const d = doc();
    const n = pageNum();
    const s = scale();
    if (!d || !canvasRef) return;
    try {
      const page = await d.getPage(n);
      const viewport = page.getViewport({ scale: s * window.devicePixelRatio });
      const ctx = canvasRef.getContext('2d');
      if (!ctx) return;
      canvasRef.width = viewport.width;
      canvasRef.height = viewport.height;
      canvasRef.style.width = `${viewport.width / window.devicePixelRatio}px`;
      canvasRef.style.height = `${viewport.height / window.devicePixelRatio}px`;
      await page.render({ canvasContext: ctx, viewport } as Parameters<typeof page.render>[0]).promise;
    } catch (e) {
      setError((e as Error).message);
    }
  });

  onCleanup(() => {
    doc()?.destroy();
  });

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: '#525659',
      }}
    >
      <Show when={doc()}>
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            padding: '6px 10px',
            background: '#323639',
            color: '#e0e0e0',
            'font-size': '12px',
            'font-family': 'system-ui, -apple-system, sans-serif',
            'border-bottom': '1px solid #1a1a1a',
          }}
        >
          <button
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
            disabled={pageNum() <= 1}
            style={navBtnStyle}
          >
            ◀
          </button>
          <span style={{ 'min-width': '54px', 'text-align': 'center' }}>
            {pageNum()} / {pageCount()}
          </span>
          <button
            onClick={() => setPageNum((p) => Math.min(pageCount(), p + 1))}
            disabled={pageNum() >= pageCount()}
            style={navBtnStyle}
          >
            ▶
          </button>
          <div style={{ width: '1px', height: '18px', background: '#555', margin: '0 6px' }} />
          <button onClick={() => setScale((s) => Math.max(0.25, s - 0.25))} style={navBtnStyle}>
            −
          </button>
          <span style={{ 'min-width': '46px', 'text-align': 'center' }}>
            {(scale() * 100).toFixed(0)}%
          </span>
          <button onClick={() => setScale((s) => Math.min(4, s + 0.25))} style={navBtnStyle}>
            +
          </button>
          <button onClick={() => setScale(1)} style={{ ...navBtnStyle, 'margin-left': '4px' }}>
            Fit
          </button>
        </div>
      </Show>
      <div
        style={{
          flex: '1',
          overflow: 'auto',
          padding: '16px',
          display: 'flex',
          'justify-content': 'center',
          'align-items': 'flex-start',
        }}
      >
        <Show
          when={props.pdfUrl}
          fallback={
            <div style={{ color: '#aaa', 'align-self': 'center', 'font-family': 'system-ui' }}>
              No PDF yet
            </div>
          }
        >
          <Show
            when={!error()}
            fallback={
              <div style={{ color: '#f88', 'align-self': 'center', 'font-family': 'monospace' }}>
                {error()}
              </div>
            }
          >
            <canvas
              ref={canvasRef}
              style={{ 'box-shadow': '0 4px 16px rgba(0,0,0,0.5)', background: 'white' }}
            />
          </Show>
        </Show>
      </div>
    </div>
  );
}

const navBtnStyle = {
  background: '#4a4d50',
  color: '#e0e0e0',
  border: '1px solid #1a1a1a',
  'border-radius': '3px',
  padding: '2px 8px',
  cursor: 'pointer',
  'font-size': '12px',
};
