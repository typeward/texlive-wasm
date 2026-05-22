/**
 * kpathsea (`kpse`) path resolution helpers.
 *
 * TeX engines look up files via kpathsea, which applies a search-path
 * expansion (`TEXMFDIST`, `TEXMFLOCAL`, etc.) and a per-format expansion
 * (e.g. `.tex` → `tex/latex//`). We don't fully reimplement kpathsea here —
 * the C-level kpse linked into the engine still does the canonical work.
 *
 * This module provides JS-side helpers for:
 *   - Normalizing TDS-relative paths from absolute /texmf-dist/... requests.
 *   - Mapping a missing-file engine error back to a likely CTAN package.
 */

/**
 * Strip a leading `/texmf-dist/` (or similar TEXMF root) prefix and return the
 * TDS-relative path. Returns null if the path doesn't look like a TEXMF read.
 */
export function tdsRelative(absPath: string): string | null {
  const roots = ['/texmf-dist/', '/texlive/texmf-dist/', '/texmf/'];
  for (const root of roots) {
    if (absPath.startsWith(root)) {
      return absPath.slice(root.length);
    }
  }
  return null;
}

/** Reverse: a TDS-relative path back to an absolute mount point path. */
export function tdsAbsolute(rel: string, mount = '/texmf-dist'): string {
  return mount + '/' + rel.replace(/^\/+/, '');
}
