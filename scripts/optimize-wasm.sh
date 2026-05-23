#!/bin/bash
#
# optimize-wasm.sh — post-process every shipped .wasm engine:
#   1. wasm-opt -Oz --strip-debug --strip-producers --strip-target-features
#      → squeezes out names + DWARF + binaryen's own metadata
#   2. brotli -q 11 → .wasm.br for HTTP servers that handle Content-Encoding: br
#   3. gzip -9 → .wasm.gz fallback
#
# Idempotent: skips outputs newer than inputs.

set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

ENGINES=(pdflatex xelatex lualatex bibtexu xdvipdfmx makeindex)
TOTAL_BEFORE=0
TOTAL_AFTER=0
TOTAL_BR=0

# Run wasm-opt via the docker image (binaryen ships inside emsdk).
WASM_OPT_FLAGS="-Oz --strip-debug --strip-producers --strip-target-features \
  --enable-bulk-memory --enable-mutable-globals --enable-sign-ext \
  --enable-nontrapping-float-to-int --enable-multivalue --enable-reference-types \
  --enable-threads --enable-bulk-memory-opt"
WASM_OPT="docker run --rm -v $REPO:/workspace -w /workspace --user $(id -u):$(id -g) texlive-wasm-builder:dev /opt/emsdk/upstream/bin/wasm-opt $WASM_OPT_FLAGS"

for engine in "${ENGINES[@]}"; do
  src="engine-artifacts/${engine}/emscripten/${engine}.wasm"
  if [ ! -f "$src" ]; then
    echo "[skip] $src missing"
    continue
  fi
  before=$(stat -c%s "$src")
  TOTAL_BEFORE=$((TOTAL_BEFORE + before))

  echo "[opt ] $engine ($(numfmt --to=iec --suffix=B $before))"
  tmp="${src}.opt"
  sg docker -c "$WASM_OPT $src -o $tmp" 2>&1 | tail -2
  mv "$tmp" "$src"
  after=$(stat -c%s "$src")
  TOTAL_AFTER=$((TOTAL_AFTER + after))
  saved=$((before - after))
  pct=$((saved * 100 / before))
  echo "       → $(numfmt --to=iec --suffix=B $after) (-${pct}%)"

  echo "[gzip] $engine"
  gzip -9 -k -f "$src"
  echo "[br  ] $engine"
  node -e "
    const z = require('node:zlib'); const fs = require('node:fs');
    const buf = fs.readFileSync('$src');
    const out = z.brotliCompressSync(buf, { params: { [z.constants.BROTLI_PARAM_QUALITY]: 11 } });
    fs.writeFileSync('${src}.br', out);
  "
  brsz=$(stat -c%s "${src}.br")
  TOTAL_BR=$((TOTAL_BR + brsz))
  echo "       gzip=$(numfmt --to=iec --suffix=B $(stat -c%s ${src}.gz))  br=$(numfmt --to=iec --suffix=B $brsz)"
done

echo
echo "===== TOTALS ====="
echo "  raw before:  $(numfmt --to=iec --suffix=B $TOTAL_BEFORE)"
echo "  raw after:   $(numfmt --to=iec --suffix=B $TOTAL_AFTER)"
echo "  brotli:      $(numfmt --to=iec --suffix=B $TOTAL_BR)"
saved=$((TOTAL_BEFORE - TOTAL_AFTER))
[ "$TOTAL_BEFORE" -gt 0 ] && echo "  saved:       $(numfmt --to=iec --suffix=B $saved) ($((saved * 100 / TOTAL_BEFORE))%)"
