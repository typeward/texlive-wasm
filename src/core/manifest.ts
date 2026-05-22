/**
 * tex-packages.json — content-addressed manifest of TL files.
 *
 * Generated at engine build time by `scripts/build-manifest.ts` by walking the
 * built TDS tree. Distributed alongside the engine artifacts.
 *
 * The runtime uses this for three things:
 *   1. Decide which backend tier should serve a given TDS path.
 *   2. Verify integrity of bytes we read out of a cache (OPFS/TauriFS) before
 *      handing them to the engine.
 *   3. Reverse-lookup which CTAN package a TDS file belongs to (used in error
 *      messages: "missing geometry.sty — try downloading the 'geometry' package").
 */

export type ManifestTier = 'core' | 'full' | 'cdn';

export interface ManifestEntry {
  /** SHA-256 of the file's bytes, hex. */
  sha256: string;
  /** File size in bytes. */
  size: number;
  /** Which delivery tier this file ships in. */
  tier: ManifestTier;
  /** CTAN package the file belongs to (best-effort; null for orphans). */
  package: string | null;
}

export interface TexPackagesManifest {
  /** Manifest format version. Bumped on schema changes. */
  schema: 1;
  /** Versioned build identifier, e.g. "texlive-2026-r0". */
  version: string;
  /** When the manifest was built (ISO 8601). */
  generatedAt: string;
  /** Brotli-compressed core-tier bundle. */
  coreBundleUrl: string | null;
  /** Brotli-compressed full-tier bundle (downloaded once on first run). */
  fullBundleUrl: string | null;
  /** CDN base URL for per-file long-tail fetches. */
  cdnBaseUrl: string | null;
  /** TDS-relative path → entry. */
  files: Record<string, ManifestEntry>;
}

export async function loadManifest(url: string): Promise<TexPackagesManifest> {
  const r = await fetch(url, { cache: 'force-cache' });
  if (!r.ok) {
    throw new Error(`Failed to load manifest from ${url}: HTTP ${r.status}`);
  }
  const json = (await r.json()) as TexPackagesManifest;
  if (json.schema !== 1) {
    throw new Error(`Unsupported manifest schema: ${json.schema}`);
  }
  return json;
}

export function tierOf(manifest: TexPackagesManifest, tdsPath: string): ManifestTier | null {
  return manifest.files[tdsPath]?.tier ?? null;
}

export function packageOf(manifest: TexPackagesManifest, tdsPath: string): string | null {
  return manifest.files[tdsPath]?.package ?? null;
}

export function expectedSha256(manifest: TexPackagesManifest, tdsPath: string): string | null {
  return manifest.files[tdsPath]?.sha256 ?? null;
}
