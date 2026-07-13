#!/bin/bash
#
# stage-engine-artifacts.sh — reshape the flat download-artifact output
#
#   engine-artifacts-staging/<engine>-<target>/{<engine>.wasm,<engine>.js,…}
#
# into the tree every script in scripts/ reads:
#
#   engine-artifacts/<engine>/<target>/…
#   engine-artifacts/icudt78l.dat        (pack-release.mjs + the xetex/bibtexu
#                                         smokes expect it at the tree root)
#
# Shared by release.yml's smoke and pack jobs so both see exactly the same
# tree — a smoke that passes on a different layout proves nothing.

set -euo pipefail

for dir in engine-artifacts-staging/*/; do
  name=$(basename "$dir")            # e.g. pdflatex-emscripten
  engine=${name%-*}
  target=${name##*-}
  mkdir -p "engine-artifacts/$engine/$target"
  cp -r "$dir"/* "engine-artifacts/$engine/$target/"
done

icu=$(find engine-artifacts -name icudt78l.dat | head -1)
if [ -n "$icu" ] && [ "$icu" != "engine-artifacts/icudt78l.dat" ]; then
  mv "$icu" engine-artifacts/icudt78l.dat
fi

ls -R engine-artifacts/ | head -40
