#!/bin/bash
#
# fetch-tds.sh — populate engine-artifacts/texmf/ with a minimal TeX Live
# Distribution tree, sufficient for compiling \documentclass{article} docs
# with pdflatex.
#
# Pulls files from Ubuntu's `texlive-latex-base` + `texlive-latex-recommended`
# packages via a one-shot Docker container, plus the pre-built `.fmt` files.
#
# Idempotent: skips if engine-artifacts/texmf already has content.
#
# Usage:
#   bash scripts/fetch-tds.sh

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$REPO_ROOT/engine-artifacts/texmf"

if [ -d "$TARGET" ] && [ "$(ls -A "$TARGET" 2>/dev/null | wc -l)" -gt 0 ]; then
  echo "TDS already populated at $TARGET (delete to re-fetch)"
  exit 0
fi

echo "Fetching minimal TDS via ubuntu:24.04 + texlive-latex-* packages..."
mkdir -p "$TARGET"

docker run --rm -v "$REPO_ROOT:/workspace" ubuntu:24.04 bash -c '
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq > /dev/null
apt-get install -qq -y --no-install-recommends \
  texlive-latex-base \
  texlive-latex-recommended \
  > /dev/null
echo "[+] copying texmf-dist tree..."
cp -r /usr/share/texlive/texmf-dist/. /workspace/engine-artifacts/texmf/
echo "[+] staging pre-built .fmt files..."
mkdir -p /workspace/engine-artifacts/texmf/web2c/pdftex
cp /var/lib/texmf/web2c/pdftex/pdflatex.fmt /workspace/engine-artifacts/texmf/web2c/pdftex/ 2>/dev/null || true
cp /var/lib/texmf/web2c/pdftex/latex.fmt    /workspace/engine-artifacts/texmf/web2c/pdftex/ 2>/dev/null || true
echo "[+] removing broken symlinks..."
find /workspace/engine-artifacts/texmf -type l -delete
chown -R '"$(id -u):$(id -g)"' /workspace/engine-artifacts/texmf
echo "[+] done"
du -sh /workspace/engine-artifacts/texmf
'

echo
echo "TDS ready at $TARGET ($(du -sh "$TARGET" | awk '{print $1}'))"
echo
echo "Notes:"
echo "- The bundled .fmt files were built by Ubuntu's pdflatex and are NOT"
echo "  binary-compatible with our wasm pdflatex. Run scripts/build-fmt.mjs"
echo "  to rebuild them with our engine."
