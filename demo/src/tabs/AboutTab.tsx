/** Static "how it works" page proving the README's claims. */

import { For } from 'solid-js';

const ENGINES = [
  ['pdfLaTeX', 'pdflatex.wasm', '1.3 MB', 'pdfTeX 3.141592653-2.6-1.40.29'],
  ['XeLaTeX', 'xelatex.wasm', '2.8 MB', 'XeTeX 0.999998, ICU 78.2'],
  ['LuaLaTeX', 'lualatex.wasm', '4.8 MB', 'LuaHBTeX 1.24.0'],
  ['BibTeXu', 'bibtexu.wasm', '877 KB', 'BibTeXu 0.99d-x4.03, ICU 78.2'],
  ['xdvipdfmx', 'xdvipdfmx.wasm', '765 KB', '.xdv → PDF driver'],
  ['makeindex', 'makeindex.wasm', '192 KB', 'index processor'],
] as const;

export function AboutTab() {
  const cell = { padding: '6px 12px', 'border-bottom': '1px solid #eee' } as const;
  return (
    <div style={{ padding: '16px 24px', overflow: 'auto', 'max-width': '760px', 'line-height': '1.6' }}>
      <h2 style={{ margin: '0 0 8px 0' }}>How this works</h2>
      <p style={{ 'font-size': '14px', color: '#444' }}>
        Every PDF on this site is produced <strong>entirely in your browser</strong>: TeX Live 2026
        (<code>branch2026</code> @ <code>fb61589266</code>) compiled to WebAssembly, one{' '}
        <code>.wasm</code> per engine, each running in its own Web Worker behind the{' '}
        <code>texlive-wasm</code> npm API (<code>createEngine</code> + <code>latexmk</code>). Open
        the Network tab: after the initial asset downloads there are no server calls — no LaTeX
        backend exists.
      </p>

      <h3 style={{ margin: '20px 0 8px 0' }}>The engines</h3>
      <table style={{ 'border-collapse': 'collapse', 'font-size': '13px' }}>
        <thead>
          <tr>
            <th style={{ ...cell, 'text-align': 'left' }}>Engine</th>
            <th style={{ ...cell, 'text-align': 'left' }}>Artifact</th>
            <th style={{ ...cell, 'text-align': 'right' }}>Size</th>
            <th style={{ ...cell, 'text-align': 'left' }}>Version</th>
          </tr>
        </thead>
        <tbody>
          <For each={ENGINES}>
            {([name, artifact, size, version]) => (
              <tr>
                <td style={cell}>{name}</td>
                <td style={{ ...cell, 'font-family': 'monospace' }}>{artifact}</td>
                <td style={{ ...cell, 'text-align': 'right' }}>{size}</td>
                <td style={cell}>{version}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>

      <h3 style={{ margin: '20px 0 8px 0' }}>What gets downloaded</h3>
      <ul style={{ 'font-size': '14px', color: '#444', 'padding-left': '20px' }}>
        <li>
          A gzipped TeX tree (<code>texmf.tar.gz</code>: LaTeX packages, fonts, formats) — the
          status bar shows the exact size; fetched once and shared by every engine via the
          browser HTTP cache.
        </li>
        <li>The engine you use, on demand (sizes above).</li>
        <li>
          ~21 MB of ICU locale data (<code>icudt78l.dat</code>) — only when XeLaTeX or BibTeXu
          start.
        </li>
      </ul>

      <h3 style={{ margin: '20px 0 8px 0' }}>Notes &amp; honest limitations</h3>
      <ul style={{ 'font-size': '14px', color: '#444', 'padding-left': '20px' }}>
        <li>
          The engines are single-threaded wasm — no SharedArrayBuffer, no COOP/COEP headers, no
          service-worker tricks. Plain static hosting (and mobile WebViews) just work.
        </li>
        <li>
          biblatex works via <code>backend=bibtex</code> (auto-detected; BibTeXu runs with{' '}
          <code>--wolfgang</code>), and CSL styles run in-engine under LuaLaTeX via citeproc-lua.
          biber itself is not shipped yet, so documents on the default biber backend won't resolve
          citations — a biber.wasm port is in progress.
        </li>
        <li>SyncTeX forward/reverse lookups are Phase-4 work (the parser lists input files today).</li>
        <li>Desktop browsers are the target; mobile devices may hit memory limits.</li>
      </ul>

      <p style={{ 'font-size': '14px' }}>
        <a href="https://github.com/typeward/texlive-wasm">GitHub repository</a> ·{' '}
        <a href="https://github.com/typeward/texlive-wasm#install">Install &amp; usage docs</a> ·
        MIT-licensed wrapper; engine artifacts inherit their TeX Live licenses.
      </p>
    </div>
  );
}
