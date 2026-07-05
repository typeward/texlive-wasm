/** Tiny cross-tab store: the sample currently loaded in the hero editor. */

import { createSignal } from 'solid-js';
import { HELLO, type Sample } from './samples';

export const [editorSample, setEditorSample] = createSignal<Sample>(HELLO);
