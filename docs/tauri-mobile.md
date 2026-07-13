# texlive-wasm inside Tauri 2 mobile apps (iOS + Android)

The library's primary target is an offline-first Tauri 2.0 app on Android and
iOS. This is the integration pattern that works, with the platform constraints
that shaped it. The desktop-only `examples/tauri/` app demonstrates the same
wiring; this document is the mobile-specific contract.

## Why it works at all: single-threaded engines

Since **v0.2.0-alpha** every engine artifact is single-threaded wasm — no
SharedArrayBuffer, no `crossOriginIsolated` requirement. This is load-bearing
for mobile: Android System WebView cannot reliably provide cross-origin
isolation, so the earlier `-pthread` builds simply would not instantiate
there. Do not re-enable `ENABLE_THREADS` for mobile targets.

Consequently you need **no COOP/COEP headers** anywhere: not in
`tauri.conf.json`, not in the vite dev server, no service-worker shims.

## Device floors

| Platform | Floor | Reason |
|---|---|---|
| iOS | **16.4** | `DecompressionStream('gzip')` (bundle unpack) needs 16.4; module workers need 15+ |
| Android | minSdk 24, **System WebView ≥ 102** | ES-module workers 80+, DecompressionStream 80+, OPFS sync handles 102+ |

Ship bundles as **gzip, not brotli** — WebKit has no
`DecompressionStream('br')`. (`src/vfs/tar.ts` auto-detects the format.)

## Asset layout — the load-bearing decision

Tauri serves two different kinds of storage, and the split matters:

1. **Webview assets (`frontendDist`)** — fetchable by URL from the page and
   from workers. The engine glue `.js` is `import()`ed and the `.wasm` /
   bundles are `fetch()`ed, so these MUST be webview assets:
   - `<engine>/emscripten/<engine>.{js,wasm}` for each engine you use
   - `texmf-core-<engine>.tar.gz` — the per-engine core bundle
     (`node scripts/pack-tds.mjs --tier core --engine pdflatex`)
   - `icudt78l.dat` when using xelatex or bibtexu
2. **Bundle resources (`$RESOURCE`)** — NOT fetchable by URL; reachable only
   through `@tauri-apps/plugin-fs` IPC. Put the **full TeX tree** here and
   read it in place with the TauriFS backend (`texlive-wasm/tauri`):

```json
// tauri.conf.json
"bundle": { "resources": { "path/to/texmf": "texmf" } }
```

```json
// capabilities: read-only access to the tree
{ "identifier": "fs:allow-read-file", "allow": [{ "path": "$RESOURCE/texmf/**" }] }
```

Don't unpack to `$APPDATA` on first launch unless resource-read latency
proves to be a problem — read-in-place has zero first-launch cost and no
doubled disk usage.

## Engine configuration

URLs must be **absolute** (the worker resolves relative paths against the
worker script URL, not your page):

```ts
import { createEngineManager } from 'texlive-wasm';
import { withTauriFs } from 'texlive-wasm/tauri';

const asset = (p: string) => new URL(p, document.baseURI).href;

const manager = createEngineManager({
  // ONE live engine on mobile: each worker holds its TDS map + wasm heap.
  maxLiveEngines: 1,
  config: (id) => ({
    enginePath: asset(`${id}/emscripten/${id}.wasm`),
    bundleUrl: asset(`texmf-core-${id}.tar.gz`),   // core tier, webview-served
    ...(id === 'xelatex' || id === 'bibtexu'
      ? { icuDataUrl: asset('icudt78l.dat') }
      : {}),
  }),
});
```

Then prepend TauriFS for the long tail (full tree in resources):

```ts
const handle = await withTauriFs(
  (vfs) => createEngine('pdflatex', { ...config, vfs }),
  { texmfRoot: 'texmf', baseDir: BaseDirectory.Resource },
);
```

For documents that pull deep package chains, allow more on-miss rounds —
local resource reads make retries cheap:

```ts
await handle.run({ args: [...], files, lazyFetch: { maxRetries: 3 } });
```

A hard missing-package error surfaces **one** file per pass, so a document
missing N packages from the core tier needs up to N rounds. Keep the core
tier honest instead of raising the ceiling: run
`node scripts/smoke-tiered.mjs <engine>` — it compiles with only the core
tier loaded and prints every long-tail fetch.

## Memory budget

A live engine worker costs roughly *(TDS bytes loaded) + (wasm heap)*. With
the core bundle (~45–70 MB raw depending on engine) instead of the full tree
(~260 MB), one worker stays comfortably inside WKWebView limits. Rules of
thumb:

- `maxLiveEngines: 1` on phones; 2 on tablets at most.
- Leave `persistTexmfVar` on (default): luaotfload's font database survives
  between runs instead of rebuilding for seconds each compile.
- Leave `lazyTds` on (default): the TeX tree's bytes stay JS-side and are
  copied into the wasm heap only as the engine reads them. If you see
  "materializing the TeX tree eagerly" in the console, the engine artifact
  predates the lazy backend — rebuild it. The fallback is correct but costs
  a full copy of the tree per engine instance.
- Catch `EngineOutOfMemoryError` (stable `error.name` across the worker
  boundary): dispose idle engines via the manager and retry once.
- On iOS, surface `didReceiveMemoryWarning` from Swift as a Tauri event and
  call `manager.dispose()` for idle engines when it fires.

## Compiling untrusted documents

TeX is a programming language. A document from someone else — a shared
project, a downloaded template — can loop forever, recurse until the heap is
gone, or write files until storage is full. None of that escapes the wasm
sandbox (there is no `\write18`: shell-escape is off and `fork` is `ENOSYS`),
but on a phone an unbounded compile is an unresponsive app and a hot battery.

- Every typed wrapper and `latexmk` carry a 5-minute default deadline
  (`DEFAULT_RUN_TIMEOUT_MS`). Lower it for untrusted input; `timeoutMs: 0`
  removes it. On `latexmk` the deadline covers the *whole pipeline*, so extra
  passes cannot extend it.
- Pass an `AbortSignal` to let the user cancel a compile.
- Enforcing either one terminates the worker, so the handle is dead
  afterwards — recreate it via the manager (which is why runs are leased: an
  engine cannot be evicted mid-compile).
- Bundle/decompression size is capped (`MAX_DECOMPRESSED_BYTES`, 512 MB) so a
  malformed or hostile archive cannot expand without bound.

## Performance notes

- The worker compiles each engine's wasm **once** and reuses the module for
  every run (WKWebView has no code cache — without this every compile would
  pay a full multi-MB wasm compile). Keep handles alive across compiles;
  don't create/dispose per run.
- The first run per worker pays the bundle unpack; later runs reuse the
  in-worker file map and mount it lazily. Expect the first compile to be
  several times slower than steady state on mobile CPUs.
- `run()` hands back only what the engine *produced* — the images and fonts
  you passed in are not echoed back across the worker boundary on every pass.
- The worker regenerates the kpathsea `ls-R` database per run and sets
  `TEXMFDBS`, so file lookups are hash hits even after lazy fetches.

## Lifecycle / background kills

Compile state is transient by design (fresh engine instance per run), so a
webview process kill loses nothing except an in-flight compile. Persist the
user's document on every edit; on reload, restore it and re-run. Engine
handles are unusable after a kill — recreate them lazily via the manager.

## App size

Engines (~11 MB total) + core bundles (~15 MB gz each, share the TDS source)
in the webview assets, full tree (~100 MB gz unpacked to ~260 MB) as a
resource: plan for a 130–150 MB installed app. Trim `bundle.resources` to
the engines you actually expose if that is too much.
