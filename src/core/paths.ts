/**
 * Path confinement for every path that reaches us from outside: caller file
 * inputs, tar entry names, TDS paths parsed out of engine logs.
 *
 * All of them are interpreted relative to a root the engine must not escape
 * (`/project` for inputs, `/texmf-dist` for the tree). A `..` segment — or a
 * tar entry named `/etc/passwd` — would place the write outside that root.
 * The escape is confined to the WASM filesystem today, but the engine also
 * reads its own configuration from there, so treat the roots as boundaries.
 */

/**
 * Normalize a caller-supplied path to a root-relative one, or return null if
 * it tries to escape. Leading slashes are stripped (an "absolute" path is
 * taken as relative to the root); `.` segments are dropped; any `..` segment
 * is a rejection rather than something to resolve, since a legitimate TDS or
 * project path never contains one.
 */
export function safeRelativePath(path: string): string | null {
  const segments = path.split(/[/\\]+/).filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return null;
  if (segments.some((s) => s === '..')) return null;
  // A Windows drive letter or a UNC-ish leading segment would be nonsense
  // inside the WASM FS; reject rather than silently reinterpret.
  if (/^[a-z]:$/i.test(segments[0]!)) return null;
  // A NUL byte truncates the path at the C boundary: everything after it is
  // invisible to us but not to the engine.
  if (segments.some((s) => s.includes('\0'))) return null;
  return segments.join('/');
}

/**
 * Resolve a path against an absolute root, or return null if it escapes.
 * `root` itself is the identity case — `cwd: '/project'` must stay legal.
 */
export function safeResolve(root: string, path: string): string | null {
  const base = root.replace(/\/+$/, '');
  // Only a path AT the root or BELOW it is inside it: "/projectile" shares a
  // prefix with "/project" and is not under it.
  const inRoot = path === base || path.startsWith(`${base}/`);
  // An absolute path pointing somewhere else entirely is not "relative to the
  // root" — it is an escape spelled without any `..`.
  if (!inRoot && path.startsWith('/')) return null;
  const rest = inRoot ? path.slice(base.length) : path;
  if (rest === '' || rest === '/') return base;
  const rel = safeRelativePath(rest);
  return rel === null ? null : `${base}/${rel}`;
}
