import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The biber build installs its pure-perl dependency closure exclusively from
// this lock (sha256-verified tarballs served out of a local mirror with
// cpanm --mirror-only). A malformed, duplicated or unpinned entry would either
// break the build or re-open the unpinned-CPAN hole, so guard its shape here.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCK = readFileSync(`${ROOT}engine/scripts/biber/cpan-lock.txt`, 'utf8');
const SPIKE = readFileSync(`${ROOT}engine/scripts/biber/spike-build.sh`, 'utf8');

const entries: Array<{ sha: string; path: string }> = LOCK.split('\n')
  .filter((line) => line.trim() && !line.startsWith('#'))
  .map((line) => {
    const [sha = '', path = ''] = line.split(/\s+/);
    return { sha, path };
  });

describe('cpan-lock.txt', () => {
  it('pins every dist by sha256 and CPAN author path', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const { sha, path } of entries) {
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
      expect(path).toMatch(/^[A-Z]\/[A-Z]{2}\/[A-Z0-9-]+\/[^/]+\.tar\.gz$/);
    }
  });

  it('has no duplicate dists', () => {
    const paths = entries.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
    // Two versions of the same dist would make the install order ambiguous.
    const names = paths.map((p) =>
      p
        .split('/')
        .pop()!
        .replace(/-[^-]+\.tar\.gz$/, ''),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('excludes the cpanm bootstrap (pinned in spike-build.sh itself)', () => {
    expect(entries.some((e) => e.path.includes('App-cpanminus'))).toBe(false);
    expect(SPIKE).toMatch(/^CPANM_SHA256=[0-9a-f]{64}$/m);
  });

  it('is the only source of pure-perl dists in the build', () => {
    // The install must stay --mirror-only (an unlocked dist then cannot be
    // resolved at all), and nothing may execute a live URL — the old
    // `curl https://cpanmin.us | perl -` bootstrap included.
    expect(SPIKE).toContain('--mirror-only');
    const code = SPIKE.split('\n').filter((line) => !line.trim().startsWith('#'));
    expect(code.some((line) => line.includes('cpanmin.us'))).toBe(false);
    expect(code.some((line) => /curl[^|]*\|\s*"?\$?\w*perl/.test(line))).toBe(false);
  });
});
