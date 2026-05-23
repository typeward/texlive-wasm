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
  texlive-latex-extra \
  texlive-fonts-recommended \
  texlive-xetex \
  texlive-luatex \
  texlive-science \
  texlive-publishers \
  texlive-bibtex-extra \
  texlive-pictures \
  lmodern \
  fonts-lmodern \
  > /dev/null
echo "[+] copying /usr/share/texlive/texmf-dist tree..."
cp -r /usr/share/texlive/texmf-dist/. /workspace/engine-artifacts/texmf/
echo "[+] merging /usr/share/texmf tree (lmodern + system fonts)..."
if [ -d /usr/share/texmf ]; then
  cp -rn /usr/share/texmf/. /workspace/engine-artifacts/texmf/ 2>/dev/null || true
fi
echo "[+] staging pre-built .fmt files..."
mkdir -p /workspace/engine-artifacts/texmf/web2c/pdftex
cp /var/lib/texmf/web2c/pdftex/pdflatex.fmt /workspace/engine-artifacts/texmf/web2c/pdftex/ 2>/dev/null || true
cp /var/lib/texmf/web2c/pdftex/latex.fmt    /workspace/engine-artifacts/texmf/web2c/pdftex/ 2>/dev/null || true
echo "[+] removing broken symlinks..."
find /workspace/engine-artifacts/texmf -type l -delete
# Wipe any leftover ls-R that points to the distro path.
rm -f /workspace/engine-artifacts/texmf/ls-R
echo "[+] trimming assets unusable in the WASM/PDF-only build..."
# Drop ~120 MB raw / ~30 MB brotli of unreachable assets:
#   fonts/source     METAFONT .mf sources, no mktexpk in WASM
#   fonts/afm        legacy dvips Adobe Font Metric
#   tex/context      ConTeXt format, not LaTeX
#   bibtex/bib       sample biblio data shipped inside packages
#   scripts/citation-style-language  biblatex CSL backend, needs biber
#   scripts/*        Perl/Java tools requiring fork
#   tex4ht/source/texdoc/texdoctk/metapost/metafont/mft/xdvi  tools we do not ship
rm -rf /workspace/engine-artifacts/texmf/fonts/source \
       /workspace/engine-artifacts/texmf/fonts/afm \
       /workspace/engine-artifacts/texmf/fonts/type1/public/cbfonts \
       /workspace/engine-artifacts/texmf/fonts/tfm/public/cbfonts \
       /workspace/engine-artifacts/texmf/tex/latex/cbfonts \
       /workspace/engine-artifacts/texmf/tex/latex/utfsym \
       /workspace/engine-artifacts/texmf/tex/latex/worldflags \
       /workspace/engine-artifacts/texmf/tex/latex/hwemoji \
       /workspace/engine-artifacts/texmf/tex/latex/twemojis \
       /workspace/engine-artifacts/texmf/tex/latex/uantwerpendocs \
       /workspace/engine-artifacts/texmf/tex/latex/nwejm \
       /workspace/engine-artifacts/texmf/tex/latex/rutitlepage \
       /workspace/engine-artifacts/texmf/tex/latex/powerdot-tuliplab \
       /workspace/engine-artifacts/texmf/tex/latex/ghsystem \
       /workspace/engine-artifacts/texmf/tex/context \
       /workspace/engine-artifacts/texmf/bibtex/bib \
       /workspace/engine-artifacts/texmf/scripts/citation-style-language \
       /workspace/engine-artifacts/texmf/scripts/texdoc \
       /workspace/engine-artifacts/texmf/scripts/l3build \
       /workspace/engine-artifacts/texmf/scripts/texlive \
       /workspace/engine-artifacts/texmf/scripts/checkcites \
       /workspace/engine-artifacts/texmf/scripts/bib2gls \
       /workspace/engine-artifacts/texmf/scripts/barracuda \
       /workspace/engine-artifacts/texmf/scripts/webquiz \
       /workspace/engine-artifacts/texmf/scripts/citeproc-lua \
       /workspace/engine-artifacts/texmf/tex4ht \
       /workspace/engine-artifacts/texmf/source \
       /workspace/engine-artifacts/texmf/texdoc \
       /workspace/engine-artifacts/texmf/texdoctk \
       /workspace/engine-artifacts/texmf/metapost \
       /workspace/engine-artifacts/texmf/metafont \
       /workspace/engine-artifacts/texmf/mft \
       /workspace/engine-artifacts/texmf/xdvi 2>/dev/null || true
echo "[+] patching texmf.cnf TEXMFROOT for wasm layout..."
# Distros set TEXMFROOT to an absolute system path (e.g. /usr/share/texlive)
# that exists on Linux but not inside our WASM virtual FS. Rewrite the root
# so bibtexu / makeindex / xdvipdfmx — which all rely on kpathsea search but
# do not accept -cnf-line= overrides — can find their support files.
if [ -f /workspace/engine-artifacts/texmf/web2c/texmf.cnf ]; then
  sed -i \
    -e "s|^TEXMFROOT = .*$|TEXMFROOT = /|" \
    -e "s|^TEXMFDIST = .*$|TEXMFDIST = /texmf-dist|" \
    -e "s|^TEXMFMAIN = .*$|TEXMFMAIN = \$TEXMFDIST|" \
    /workspace/engine-artifacts/texmf/web2c/texmf.cnf
fi
chown -R '"$(id -u):$(id -g)"' /workspace/engine-artifacts/texmf
echo "[+] done"
du -sh /workspace/engine-artifacts/texmf
'

echo
echo "[+] generating ls-R (kpathsea filename database)..."
node -e "
const { readdirSync, statSync, writeFileSync } = require('node:fs');
const ROOT = process.argv[1];
const lines = ['% ls-R -- filename database for kpathsea; do not change this line.'];
function walk(rel) {
  const abs = ROOT + (rel ? '/' + rel : '');
  let entries;
  try { entries = readdirSync(abs); } catch { return; }
  const files = []; const dirs = [];
  for (const e of entries) {
    try {
      const st = statSync(abs + '/' + e);
      if (st.isDirectory()) { files.push(e); dirs.push(e); }
      else if (st.isFile()) { files.push(e); }
    } catch {}
  }
  if (files.length) {
    lines.push('');
    lines.push('./' + rel + ':');
    for (const f of files) lines.push(f);
  }
  for (const d of dirs) walk(rel ? rel + '/' + d : d);
}
walk('');
writeFileSync(ROOT + '/ls-R', lines.join('\n') + '\n');
console.log('  ls-R: ' + lines.length + ' entries, ' + Math.round(lines.join('\n').length/1024) + ' KB');
" "$TARGET"

echo
echo "TDS ready at $TARGET ($(du -sh "$TARGET" | awk '{print $1}'))"
echo
echo "Notes:"
echo "- The bundled .fmt files were built by Ubuntu's pdflatex and are NOT"
echo "  binary-compatible with our wasm pdflatex. Run scripts/build-fmt.mjs"
echo "  to rebuild them with our engine."
