/**
 * Showcase shell: header, hash-routed tab bar, cross-origin-isolation guard
 * banner, tab bodies, and a status footer fed by engine-manager signals.
 *
 * All TeX work goes through the actual `texlive-wasm` npm API (see
 * engine-manager.ts) — this app is the library's reference consumer.
 */

import { For, Match, Show, Switch, createSignal, onCleanup } from 'solid-js';
import { CompilePanel } from './CompilePanel';
import { engineStatus, tdsProgress } from './engine-manager';
import { BIBLIOGRAPHY, INDEX, LUALATEX, RERUN, XELATEX } from './samples';
import { editorSample } from './store';
import { AboutTab } from './tabs/AboutTab';
import { GalleryTab } from './tabs/GalleryTab';
import { SynctexTab } from './tabs/SynctexTab';

const TABS = [
  { id: 'editor', label: 'Editor' },
  { id: 'xelatex', label: 'XeLaTeX' },
  { id: 'lualatex', label: 'LuaLaTeX' },
  { id: 'bibliography', label: 'Bibliography' },
  { id: 'index', label: 'Index' },
  { id: 'rerun', label: 'Multi-pass' },
  { id: 'synctex', label: 'SyncTeX' },
  { id: 'gallery', label: 'Gallery' },
  { id: 'about', label: 'About' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function currentTab(): TabId {
  const id = location.hash.replace(/^#/, '');
  return (TABS.some((t) => t.id === id) ? id : 'editor') as TabId;
}

export function App() {
  const [tab, setTab] = createSignal<TabId>(currentTab());
  const onHash = () => setTab(currentTab());
  window.addEventListener('hashchange', onHash);
  onCleanup(() => window.removeEventListener('hashchange', onHash));

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100vh',
        'font-family': 'system-ui, -apple-system, sans-serif',
      }}
    >
      <header
        style={{
          display: 'flex',
          'align-items': 'baseline',
          gap: '12px',
          padding: '10px 16px',
          'border-bottom': '1px solid #ddd',
          background: '#2f3e55',
          color: '#fff',
        }}
      >
        <strong style={{ 'font-size': '16px' }}>texlive-wasm</strong>
        <span style={{ 'font-size': '12px', opacity: '0.8' }}>
          TeX Live 2026 · seven engines · 100% in your browser
        </span>
        <a
          href="https://github.com/typeward/texlive-wasm"
          style={{ 'margin-left': 'auto', color: '#cdd7e5', 'font-size': '13px' }}
        >
          GitHub →
        </a>
      </header>

      <nav style={{ display: 'flex', gap: '2px', padding: '6px 12px 0 12px', 'border-bottom': '1px solid #ddd' }}>
        <For each={TABS}>
          {(t) => (
            <a
              href={`#${t.id}`}
              style={{
                padding: '6px 14px',
                'font-size': '13px',
                'text-decoration': 'none',
                color: tab() === t.id ? '#2f3e55' : '#777',
                'border-bottom': tab() === t.id ? '2px solid #2f3e55' : '2px solid transparent',
                'font-weight': tab() === t.id ? '600' : '400',
              }}
            >
              {t.label}
            </a>
          )}
        </For>
      </nav>

      <main style={{ flex: '1', display: 'flex', 'flex-direction': 'column', 'min-height': '0' }}>
        <Switch>
          <Match when={tab() === 'editor'}>
            <CompilePanel
              sample={editorSample()}
              showSteps={true}
              intro={
                <>
                  Live LaTeX editor driven by <code>latexmk()</code> from the{' '}
                  <code>texlive-wasm</code> npm package — bibliography, index and rerun handling
                  are automatic. Try a project from the <a href="#gallery">gallery</a>.
                </>
              }
            />
          </Match>
          <Match when={tab() === 'xelatex'}>
            <CompilePanel
              sample={XELATEX}
              showSteps={true}
              intro={
                <>
                  WASM XeTeX can't spawn processes, so its usual "call xdvipdfmx for me" driver
                  mode is impossible. Instead, <code>latexmk</code> runs XeTeX with{' '}
                  <code>--no-pdf</code>, then hands the <code>.xdv</code> to a{' '}
                  <strong>separate xdvipdfmx worker</strong> — watch the pipeline list below the
                  editor.
                </>
              }
            />
          </Match>
          <Match when={tab() === 'lualatex'}>
            <CompilePanel
              sample={LUALATEX}
              showSteps={true}
              intro={
                <>
                  LuaHBTeX 1.24.0: the largest engine (4.8 MB) with a full Lua interpreter inside —{' '}
                  <code>\directlua</code> computes values at typesetting time.
                </>
              }
            />
          </Match>
          <Match when={tab() === 'bibliography'}>
            <CompilePanel
              sample={BIBLIOGRAPHY}
              showSteps={true}
              intro={
                <>
                  <code>latexmk</code> detects <code>\bibliography{'{'}refs{'}'}</code>, runs{' '}
                  <strong>BibTeXu</strong> (Unicode BibTeX) in its own worker against the{' '}
                  <code>.aux</code>, and reruns pdfTeX until the citation resolves. First use also
                  fetches ~21 MB of ICU locale data.
                </>
              }
            />
          </Match>
          <Match when={tab() === 'index'}>
            <CompilePanel
              sample={INDEX}
              showSteps={true}
              intro={
                <>
                  <code>\index{'{'}…{'}'}</code> entries land in an <code>.idx</code>;{' '}
                  <strong>makeindex</strong> (the smallest engine — 192 KB) sorts and merges them,
                  and a rerun typesets the final index page.
                </>
              }
            />
          </Match>
          <Match when={tab() === 'rerun'}>
            <CompilePanel
              sample={RERUN}
              showSteps={true}
              intro={
                <>
                  A table of contents and forward references can't be right on the first pass.{' '}
                  <code>latexmk</code> reruns the engine until the <code>.aux</code> stabilizes and
                  no "Rerun" warnings remain — the pass count shows in the status line.
                </>
              }
            />
          </Match>
          <Match when={tab() === 'synctex'}>
            <SynctexTab />
          </Match>
          <Match when={tab() === 'gallery'}>
            <GalleryTab />
          </Match>
          <Match when={tab() === 'about'}>
            <AboutTab />
          </Match>
        </Switch>
      </main>

      <footer
        style={{
          padding: '6px 16px',
          'border-top': '1px solid #ddd',
          'font-size': '12px',
          color: '#666',
          display: 'flex',
          gap: '16px',
          'min-height': '18px',
        }}
      >
        <span>{engineStatus()}</span>
        <Show when={tdsProgress()}>
          {(p) => (
            <span>
              TeX tree: {(p().loaded / 1024 / 1024).toFixed(1)} /{' '}
              {(p().total / 1024 / 1024).toFixed(1)} MB
            </span>
          )}
        </Show>
      </footer>
    </div>
  );
}
