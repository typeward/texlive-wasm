/**
 * TauriFS is the one backend whose paths land on the user's real filesystem:
 * plugin-fs resolves them against a base dir with the app's own permissions.
 * A TDS path parsed out of an engine log must never reach it unconfined.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const readFile = vi.fn(async () => new Uint8Array([1, 2, 3]));
const exists = vi.fn(async () => true);

vi.mock('@tauri-apps/plugin-fs', () => ({ readFile, exists }));

import { createTauriFs } from '../src/vfs/taurifs';

afterEach(() => {
  readFile.mockClear();
  exists.mockClear();
});

const backend = () => createTauriFs({ texmfRoot: 'texmf', baseDir: 14 });

describe('createTauriFs', () => {
  it('reads a TDS path under the texmf root', async () => {
    const fs = await backend();
    expect(await fs.read('tex/latex/base/article.cls')).toEqual(new Uint8Array([1, 2, 3]));
    expect(readFile).toHaveBeenCalledWith('texmf/tex/latex/base/article.cls', { baseDir: 14 });
  });

  it('treats a leading slash as root-relative, not absolute', async () => {
    const fs = await backend();
    await fs.read('/tex/latex/base/article.cls');
    expect(readFile).toHaveBeenCalledWith('texmf/tex/latex/base/article.cls', { baseDir: 14 });
  });

  it('never hands plugin-fs a path that escapes the texmf root', async () => {
    const fs = await backend();
    for (const path of [
      '../../../etc/passwd',
      'tex/../../../.ssh/id_rsa',
      '..\\..\\Windows\\System32\\config\\SAM',
      'C:/Windows/System32/config/SAM',
    ]) {
      expect(await fs.read(path)).toBeNull();
      expect(await fs.exists!(path)).toBe(false);
    }
    expect(readFile).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });
});
