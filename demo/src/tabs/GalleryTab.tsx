/** Sample gallery: cards that load a project into the hero editor. */

import { For } from 'solid-js';
import { ALL_SAMPLES } from '../samples';
import { setEditorSample } from '../store';

export function GalleryTab() {
  return (
    <div style={{ padding: '16px', overflow: 'auto' }}>
      <p style={{ 'font-size': '14px', color: '#555', margin: '0 0 16px 0' }}>
        Every sample below is compiled by the engines running in your browser — pick one and it
        opens in the editor.
      </p>
      <div
        style={{
          display: 'grid',
          'grid-template-columns': 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '12px',
        }}
      >
        <For each={ALL_SAMPLES}>
          {(sample) => (
            <div
              style={{
                border: '1px solid #ddd',
                'border-radius': '6px',
                padding: '12px',
                display: 'flex',
                'flex-direction': 'column',
                gap: '8px',
              }}
            >
              <div style={{ display: 'flex', 'align-items': 'baseline', gap: '8px' }}>
                <strong style={{ 'font-size': '14px' }}>{sample.title}</strong>
                <code style={{ 'font-size': '11px', color: '#888' }}>{sample.engine}</code>
              </div>
              <div style={{ 'font-size': '12px', color: '#666', flex: '1' }}>{sample.blurb}</div>
              <button
                onClick={() => {
                  setEditorSample(sample);
                  location.hash = '#editor';
                }}
                style={{
                  'align-self': 'flex-start',
                  padding: '4px 12px',
                  'font-size': '12px',
                  cursor: 'pointer',
                }}
              >
                Open in editor →
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
