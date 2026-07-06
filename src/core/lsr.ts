/**
 * kpathsea `ls-R` filename-database rendering.
 *
 * The worker regenerates the db from its in-memory TDS map on every fresh
 * engine instance, so `$TEXMFDBS` lookups are always exact — including files
 * added by the lazy-fetch retry after the bundled ls-R was created.
 */

/**
 * Render an ls-R database for the given TDS-relative file paths. Every
 * directory gets its own `./dir:` block listing files and immediate
 * subdirectories — the shape kpathsea's db parser expects.
 */
export function buildLsR(paths: Iterable<string>): string {
  const byDir = new Map<string, Set<string>>();
  const entry = (dir: string, name: string) => {
    let set = byDir.get(dir);
    if (!set) byDir.set(dir, (set = new Set()));
    set.add(name);
  };
  for (const path of paths) {
    if (path === 'ls-R') continue; // the db must not index itself
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      entry(parts.slice(0, i).join('/'), parts[i]!);
    }
  }
  const lines = ['% ls-R -- filename database for kpathsea; do not change this line.'];
  for (const dir of [...byDir.keys()].sort()) {
    lines.push('', `./${dir}:`, ...[...byDir.get(dir)!].sort());
  }
  return lines.join('\n') + '\n';
}
