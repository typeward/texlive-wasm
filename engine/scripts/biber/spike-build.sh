#!/bin/bash
#
# spike-build.sh — M3 biber.wasm feasibility spike, stage by stage.
#
#   stage 1: perl-native      host perl (miniperl + generate_uudmap + full install)
#   stage 2: perl-emscripten  cross Perl 5.42 → libperl.a + static-ext perl (wasm)
#   stage 3+ (XS, biber tree) land here as the spike progresses.
#
# Run inside the texlive-wasm-builder container:
#   docker run --rm -v <repo>:/workspace -w /workspace/engine \
#     texlive-wasm-builder:dev bash scripts/biber/spike-build.sh <stage>
#
# Recipe notes: settings map from zeroperl (MIT); Emscripten replaces the
# WASI pieces (native sjlj via -sSUPPORT_LONGJMP, complete libc).

set -euo pipefail

STAGE="${1:-all}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"          # engine/
BUILD="$ROOT/build/biber"
SCRIPTS="$ROOT/scripts/biber"
NPROC=$(nproc)

# Heap ceiling for the browser link, mirroring targets/common.mk's MAX_MEMORY
# (exported by make, so `make biber-emscripten MAX_MEMORY=1GB` reaches here).
MAX_MEMORY="${MAX_MEMORY:-2147483648}"

PERL_VERSION=5.42.0
PERL_SHA256=e093ef184d7f9a1b9797e2465296f55510adb6dab8842b0c3ed53329663096dc
PERL_URLS=(
  "https://www.cpan.org/src/5.0/perl-$PERL_VERSION.tar.gz"
  "https://cpan.metacpan.org/src/5.0/perl-$PERL_VERSION.tar.gz"
)

# cpanminus is a build dependency like any other: the bootstrap used to pipe
# whatever bytes cpanmin.us served straight into perl. The dist ships the same
# fatpacked bin/cpanm, so pin and verify it instead of executing a live URL.
CPANM_VERSION=1.7049
CPANM_SHA256=b9ffb88e62a06aa91bd7d5a28ef6bdbb942608aea90e3969aa29b33640035214
CPANM_URLS=(
  "https://cpan.metacpan.org/authors/id/M/MI/MIYAGAWA/App-cpanminus-$CPANM_VERSION.tar.gz"
  "https://www.cpan.org/authors/id/M/MI/MIYAGAWA/App-cpanminus-$CPANM_VERSION.tar.gz"
)
CPANM="$BUILD/native/bin/cpanm"

# The dists cpanm resolves are pinned too: cpan-lock.txt is the full closure
# (65 dists, sha256 from each author's PAUSE-signed CHECKSUMS, in dependency
# order), fetched into a local mirror and installed from there. Regenerate it
# with `spike-build.sh cpan-lock` after changing CPAN_MODULES.
CPAN_LOCK="$SCRIPTS/cpan-lock.txt"
CPAN_MIRROR="$BUILD/cpan-mirror"

# Biber's pure-perl runtime deps (its Build.PL requirements minus: XS, which
# is handled as static exts; network/LWP; tool-mode XSLT; build-time
# Module::Build) plus the SAX pair the XML stack needs. These names are INPUT
# TO THE LOCK GENERATOR ONLY — a build installs cpan-lock.txt, never a live
# resolution of this list.
# NOTE: never list a dist here whose dep tree includes XML::LibXML — cpanm
# would try to build it natively; the wasm perl has it statically.
# (XML::LibXML::Simple is staged file-wise in the biber stage instead.)
CPAN_MODULES=(
  XML::SAX XML::NamespaceSupport
  Business::ISBN Business::ISMN Business::ISSN Class::Accessor
  Data::Compare Data::Dump Data::Uniqid DateTime::Format::Builder
  DateTime::Calendar::Julian File::Slurper IO::String IPC::Run3
  List::AllUtils Lingua::Translit Log::Log4perl MIME::Charset
  Parse::RecDescent Regexp::Common Text::CSV Text::Roman URI
  XML::Writer
)

# Step-2 XS payload. CPAN pins verified byte-identical across cpan.org and
# metacpan; libxml2 verified against GNOME's published .sha256sum.
LIBXML2_VERSION=2.13.8
LIBXML2_SHA256=277294cb33119ab71b2bc81f2f445e9bc9435b893ad15bb2cd2b0e859a0ee84a
LIBXML2_URLS=(
  "https://download.gnome.org/sources/libxml2/2.13/libxml2-$LIBXML2_VERSION.tar.xz"
)
TEXTBIBTEX_VERSION=0.91
TEXTBIBTEX_SHA256=3f0113cf8fe71dc7484636dc8e2a581637ecbcc82d0be29bbd46d0bf3f8cdb37
TEXTBIBTEX_URLS=(
  "https://cpan.metacpan.org/authors/id/A/AM/AMBS/Text-BibTeX-$TEXTBIBTEX_VERSION.tar.gz"
  "https://www.cpan.org/authors/id/A/AM/AMBS/Text-BibTeX-$TEXTBIBTEX_VERSION.tar.gz"
)
XMLLIBXML_VERSION=2.0210
XMLLIBXML_SHA256=a29bf3f00ab9c9ee04218154e0afc8f799bf23674eb99c1a9ed4de1f4059a48d
XMLLIBXML_URLS=(
  "https://cpan.metacpan.org/authors/id/S/SH/SHLOMIF/XML-LibXML-$XMLLIBXML_VERSION.tar.gz"
  "https://www.cpan.org/authors/id/S/SH/SHLOMIF/XML-LibXML-$XMLLIBXML_VERSION.tar.gz"
)

# Step-3: the remaining XS deps biber loads unconditionally (Sort::Key,
# `no autovivification`, Unicode::GCString/LineBreak with bundled sombok) —
# plain MakeMaker dists dropped into ext/ as-is.
SORTKEY_VERSION=1.33
SORTKEY_SHA256=ed6a4ccfab094c9cd164f564024e98bd21d94f4312ccac4d6246d22b34081acf
SORTKEY_URLS=(
  "https://cpan.metacpan.org/authors/id/S/SA/SALVA/Sort-Key-$SORTKEY_VERSION.tar.gz"
  "https://www.cpan.org/authors/id/S/SA/SALVA/Sort-Key-$SORTKEY_VERSION.tar.gz"
)
AUTOVIV_VERSION=0.18
AUTOVIV_SHA256=2d99975685242980d0a9904f639144c059d6ece15899efde4acb742d3253f105
AUTOVIV_URLS=(
  "https://cpan.metacpan.org/authors/id/V/VP/VPIT/autovivification-$AUTOVIV_VERSION.tar.gz"
  "https://www.cpan.org/authors/id/V/VP/VPIT/autovivification-$AUTOVIV_VERSION.tar.gz"
)
ULB_VERSION=2019.001
ULB_SHA256=486762e4cacddcc77b13989f979a029f84630b8175e7fef17989e157d4b6318a
ULB_URLS=(
  "https://cpan.metacpan.org/authors/id/N/NE/NEZUMI/Unicode-LineBreak-$ULB_VERSION.tar.gz"
  "https://www.cpan.org/authors/id/N/NE/NEZUMI/Unicode-LineBreak-$ULB_VERSION.tar.gz"
)
# Clone is XS-MANDATORY (Data::Compare pulls it in Biber::Config) —
# tiny self-contained XS, static ext.
CLONE_VERSION=0.47
CLONE_SHA256=4c2c0cb9a483efbf970cb1a75b2ca75b0e18cb84bcb5c09624f86e26b09c211d
CLONE_URLS=(
  "https://cpan.metacpan.org/authors/id/A/AT/ATOOMIC/Clone-$CLONE_VERSION.tar.gz"
  "https://www.cpan.org/authors/id/A/AT/ATOOMIC/Clone-$CLONE_VERSION.tar.gz"
)
# DateTime is XS-MANDATORY (unconditional XSLoader; no pure fallback) —
# static ext like the others. Self-contained XS, plain MakeMaker.
DATETIME_VERSION=1.66
DATETIME_SHA256=afabd686fb83d3ebf49ee453974f9122f3eec9b25ff8d2ddf4f12de92af1e5e2
DATETIME_URLS=(
  "https://cpan.metacpan.org/authors/id/D/DR/DROLSKY/DateTime-$DATETIME_VERSION.tar.gz"
  "https://www.cpan.org/authors/id/D/DR/DROLSKY/DateTime-$DATETIME_VERSION.tar.gz"
)
XLSIMPLE_VERSION=1.01
XLSIMPLE_SHA256=cd98c8104b70d7672bfa26b4513b78adf2b4b9220e586aa8beb1a508500365a6
XLSIMPLE_URLS=(
  "https://cpan.metacpan.org/authors/id/M/MA/MARKOV/XML-LibXML-Simple-$XLSIMPLE_VERSION.tar.gz"
  "https://www.cpan.org/authors/id/M/MA/MARKOV/XML-LibXML-Simple-$XLSIMPLE_VERSION.tar.gz"
)
# Biber itself: version LOCKSTEP with the TDS biblatex (Ubuntu noble ships
# biblatex 3.19 → biber 2.19). GitHub tag archive — SourceForge mirrors
# serve inconsistent bytes for the same path (observed live), git archives
# are deterministic.
BIBER_VERSION=2.19
BIBER_SHA256=1c1266bc8adb1637c4c59e23c47d919c5a38da4e53544a3c22c21de4a68fc9fe
BIBER_URLS=(
  "https://github.com/plk/biber/archive/refs/tags/v$BIBER_VERSION.tar.gz"
)

mkdir -p "$BUILD"
TARBALL="$BUILD/perl-$PERL_VERSION.tar.gz"

fetch_perl() {
  [ -f "$TARBALL" ] && return 0
  bash "$ROOT/scripts/fetch-verify.sh" "$TARBALL" "$PERL_SHA256" "${PERL_URLS[@]}"
}

stage_native() {
  local dir="$BUILD/perl-native-src"
  local out="$BUILD/native"
  if [ -x "$out/miniperl" ] && [ -x "$out/generate_uudmap" ] && [ -x "$out/prefix/bin/perl" ]; then
    echo "==> [native] up to date"; return 0
  fi
  fetch_perl
  rm -rf "$dir" && mkdir -p "$dir" "$out"
  tar -xzf "$TARBALL" -C "$dir" --strip-components=1
  cd "$dir"
  ./Configure -des -Dprefix="$out/prefix" -Dman1dir=none -Dman3dir=none >/dev/null
  make -j"$NPROC" >/dev/null
  make install >/dev/null
  cp -p miniperl generate_uudmap "$out/"
  echo "==> [native] done: $("$out/miniperl" -e 'print $]')"
}

# The installer: bin/cpanm out of the sha256-pinned App-cpanminus tarball IS
# the fatpacked script cpanmin.us serves, so it needs no installation of its
# own — copy it out and always run it through the native perl.
fetch_cpanm() {
  [ -x "$CPANM" ] && return 0
  local ct="$BUILD/App-cpanminus-$CPANM_VERSION.tar.gz"
  [ -f "$ct" ] || bash "$ROOT/scripts/fetch-verify.sh" "$ct" "$CPANM_SHA256" "${CPANM_URLS[@]}"
  local ctmp
  ctmp=$(mktemp -d)
  tar -xzf "$ct" -C "$ctmp" --strip-components=1
  mkdir -p "$(dirname "$CPANM")"
  cp "$ctmp/bin/cpanm" "$CPANM"
  chmod +x "$CPANM"
  rm -rf "$ctmp"
  echo "==> [cpanm] App-cpanminus $CPANM_VERSION (sha256-pinned)"
}

# Materialise cpan-lock.txt into a local CPAN mirror. Same gate as every other
# source tarball: fetch-verify.sh refuses anything whose sha256 does not match.
fetch_cpan_mirror() {
  local sha path out
  while read -r sha path; do
    case "$sha" in '' | \#*) continue ;; esac
    out="$CPAN_MIRROR/authors/id/$path"
    [ -f "$out" ] && continue
    mkdir -p "$(dirname "$out")"
    bash "$ROOT/scripts/fetch-verify.sh" "$out" "$sha" \
      "https://cpan.metacpan.org/authors/id/$path" \
      "https://www.cpan.org/authors/id/$path"
  done < "$CPAN_LOCK"
}

# Pure-perl runtime deps, staged with the NATIVE perl's cpanm into a lib
# tree the wasm perl reads via -I (pure perl is architecture-independent).
#
# Two resolvers:
#  - LOCKED (the default): install cpan-lock.txt's closure of sha256-verified
#    tarballs, in dependency order, from a local mirror with --mirror-only.
#    That mirror carries no package index, so a dist the lock forgot cannot be
#    silently pulled off CPAN — the build fails and the lock gets regenerated
#    (`spike-build.sh cpan-lock`) rather than quietly floating.
#  - LIVE (BIBER_CPAN_LOCK=0): let cpanm resolve CPAN_MODULES against live
#    CPAN. Kept as the escape hatch for regenerating the lock and for
#    debugging a dependency change.
#
# cpanminus itself is sha256-pinned either way — no more piping a live URL
# into perl.
stage_purelib() {
  local native="$BUILD/native"
  local purelib="$BUILD/purelib"
  local nperl="$native/prefix/bin/perl"
  [ -x "$nperl" ] || { echo "run stage native first" >&2; exit 1; }
  fetch_cpanm
  # --pp: dual-life dists must build PURE (native XS .pm files land in the
  # host arch dir the wasm perl never searches).
  if [ "${BIBER_CPAN_LOCK:-1}" = "1" ]; then
    [ -f "$CPAN_LOCK" ] || { echo "missing $CPAN_LOCK — run stage cpan-lock" >&2; exit 1; }
    fetch_cpan_mirror
    local tarballs=() sha path
    while read -r sha path; do
      case "$sha" in '' | \#*) continue ;; esac
      tarballs+=("$CPAN_MIRROR/authors/id/$path")
    done < "$CPAN_LOCK"
    "$nperl" "$CPANM" -L "$purelib" --notest --pp \
      --mirror "file://$CPAN_MIRROR" --mirror-only \
      "${tarballs[@]}" 2>&1 | tail -3
    echo "==> [purelib] ${#tarballs[@]} locked dists (sha256-verified)"
  else
    "$nperl" "$CPANM" -L "$purelib" --notest --pp "${CPAN_MODULES[@]}" 2>&1 | tail -3
    echo "==> [purelib] ${#CPAN_MODULES[@]} modules resolved against LIVE CPAN — unpinned (BIBER_CPAN_LOCK=0)"
  fi
  merge_archdir_pms
  echo "==> [purelib] $(find "$purelib/lib/perl5" -name '*.pm' | wc -l) modules staged"
}

# Maintainer-only: re-resolve CPAN_MODULES against live CPAN and rewrite
# cpan-lock.txt from what cpanm actually installed. This is the ONE place
# unpinned CPAN metadata enters the build — run it deliberately, diff the
# lock, commit it. Never part of `all` or of the Makefile's biber chain.
stage_cpan_lock() {
  local native="$BUILD/native"
  local nperl="$native/prefix/bin/perl"
  local resolve="$BUILD/cpan-resolve"
  [ -x "$nperl" ] || { echo "run stage native first" >&2; exit 1; }
  fetch_cpanm
  rm -rf "$resolve"
  echo "==> [cpan-lock] resolving ${#CPAN_MODULES[@]} modules against live CPAN"
  "$nperl" "$CPANM" -L "$resolve" --notest --pp "${CPAN_MODULES[@]}" 2>&1 | tail -3
  node "$SCRIPTS/gen-cpan-lock.mjs" "$resolve" "$CPAN_LOCK"
}

# Safety net for dists that ignore PUREPERL_ONLY: their pure .pm files
# install under the HOST arch dir, invisible to the wasm perl (it searches
# its own archname). Merge them up, leaving native auto/*.so behind — a
# module that truly needs its XS then fails with a clear XSLoader message.
merge_archdir_pms() {
  local purelib="$BUILD/purelib"
  local archname
  archname=$("$BUILD/native/prefix/bin/perl" -MConfig -e 'print $Config{archname}')
  if [ -d "$purelib/lib/perl5/$archname" ]; then
    (cd "$purelib/lib/perl5/$archname" && find . -name '*.pm' -not -path './auto/*' | while read -r pm; do
      mkdir -p "$purelib/lib/perl5/$(dirname "$pm")"
      cp -n "$pm" "$purelib/lib/perl5/$pm"
    done)
  fi
}

stage_cross() {
  local dir="$BUILD/perl-emcc-src"
  local native="$BUILD/native"
  [ -x "$native/miniperl" ] || { echo "run stage native first" >&2; exit 1; }
  # emcc on PATH once, instead of per-perlcc-invocation.
  source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1
  fetch_perl
  rm -rf "$dir" && mkdir -p "$dir"
  tar -xzf "$TARBALL" -C "$dir" --strip-components=1
  cd "$dir"

  # Step-2 XS dists ride along whenever their tarballs have been fetched
  # (stage xs-fetch) — Configure only picks up ext/ members present at
  # Configure time, and this stage wipes the tree.
  local tb="$BUILD/Text-BibTeX-$TEXTBIBTEX_VERSION.tar.gz"
  if [ -f "$tb" ]; then
    local tbtmp
    tbtmp=$(mktemp -d)
    tar -xzf "$tb" -C "$tbtmp" --strip-components=1
    # Flatten to the shape Makefile.PL.text-bibtex expects (see its header):
    # btparse C + XS glue in the root, pccts as a subdir with its config.h
    # renamed so it can never shadow perl's own config.h.
    local ext=ext/Text-BibTeX
    mkdir -p "$ext/pccts" "$ext/lib"
    cp "$tbtmp"/btparse/src/*.c "$tbtmp"/btparse/src/*.h "$ext/"
    cp "$tbtmp"/xscode/BibTeX.xs "$tbtmp"/xscode/btxs_support.* "$ext/"
    cp "$tbtmp"/typemap "$ext/"
    cp -r "$tbtmp"/lib/. "$ext/lib/"
    cp "$tbtmp"/btparse/pccts/*.h "$tbtmp"/btparse/pccts/ast.c "$ext/pccts/"
    mv "$ext/pccts/config.h" "$ext/pccts/pccts_config.h"
    # The ANTLR-generated parser in the root includes "config.h" too.
    sed -i 's/"config\.h"/"pccts_config.h"/' "$ext"/pccts/*.h "$ext"/pccts/ast.c "$ext"/*.c
    rm -f "$ext/bt_config.h.in"
    cp "$SCRIPTS/bt_config.h" "$ext/"
    cp "$SCRIPTS/Makefile.PL.text-bibtex" "$ext/Makefile.PL"
    rm -rf "$tbtmp"
    echo "==> [cross] staged ext/Text-BibTeX (flattened static layout)"
  fi
  local xl="$BUILD/XML-LibXML-$XMLLIBXML_VERSION.tar.gz"
  if [ -f "$xl" ]; then
    mkdir -p ext/XML-LibXML
    tar -xzf "$xl" -C ext/XML-LibXML --strip-components=1
    # Its Makefile.PL locates libxml2 through Alien::Libxml2, which cannot
    # exist in a cross build — swap the Alien wrapper for direct flags from
    # our wasm libxml2 prefix ($XMLPREFIX, exported below).
    sed -i \
      -e 's|^use Alien::Base::Wrapper.*$|# texlive-wasm: Alien wrapper replaced by direct XMLPREFIX flags|' \
      -e 's|^my %xsbuild = Alien::Base::Wrapper->mm_args;.*$|my %xsbuild = ( INC => "-I$ENV{XMLPREFIX}/include/libxml2", LIBS => "-L$ENV{XMLPREFIX}/lib -lxml2" );|' \
      ext/XML-LibXML/Makefile.PL
    echo "==> [cross] staged ext/XML-LibXML (Alien wrapper bypassed)"
  fi
  # Step-3 XS deps: plain MakeMaker dists, dropped into ext/ unmodified.
  local dist
  for dist in \
    "Sort-Key:$BUILD/Sort-Key-$SORTKEY_VERSION.tar.gz" \
    "autovivification:$BUILD/autovivification-$AUTOVIV_VERSION.tar.gz" \
    "Clone:$BUILD/Clone-$CLONE_VERSION.tar.gz" \
    "DateTime:$BUILD/DateTime-$DATETIME_VERSION.tar.gz" \
    "Unicode-LineBreak:$BUILD/Unicode-LineBreak-$ULB_VERSION.tar.gz"; do
    local name="${dist%%:*}" tarball="${dist#*:}"
    if [ -f "$tarball" ]; then
      mkdir -p "ext/$name"
      tar -xzf "$tarball" -C "ext/$name" --strip-components=1
      echo "==> [cross] staged ext/$name"
    fi
  done
  if [ -f ext/Unicode-LineBreak/Makefile.PL.sombok ]; then
    # The sombok sub-build asks MakeMaker for $(PERL_INC), which resolves
    # through the CROSS Config to the nonexistent /perl prefix. A relative
    # override is not enough either: the compile rules `cd lib &&` first,
    # shifting any relative -I one level. Hardwire the ABSOLUTE in-tree
    # perl root. (INC escapes the dollar inside a Perl string, H does not
    # — replace both spellings.)
    sed -i -e "s|\\\\\$(PERL_INC)|$dir|g" -e "s|\$(PERL_INC)|$dir|g" \
      ext/Unicode-LineBreak/Makefile.PL.sombok
  fi

  # XML::LibXML's Makefile.PL locates libxml2 through xml2-config.
  if [ -x "$BUILD/wasm-libs/libxml2/bin/xml2-config" ]; then
    export PATH="$BUILD/wasm-libs/libxml2/bin:$PATH"
    export XMLPREFIX="$BUILD/wasm-libs/libxml2"
  fi

  # Install our hints with paths substituted. Configure's probes run on the
  # BUILD HOST (perlcc try.c trick) and several of them OVERRIDE hint values
  # with glibc answers (d_perl_lc_all_uses_name_value_pairs bit us first) —
  # config.over is sourced after ALL probing and always wins, so the same
  # settings go there too.
  sed -e "s|__PERLCC__|$SCRIPTS/perlcc|g" \
      -e "s|__NATIVE_DIR__|$native|g" \
      "$SCRIPTS/hints-emscripten.sh" > hints/emscripten.sh
  cp hints/emscripten.sh config.over
  chmod +x "$SCRIPTS/perlcc"
  # Platform stubs referenced via archobjs in the hints.
  cp "$SCRIPTS/emstubs.c" .

  echo "==> [cross] Configure (hints: emscripten + config.over)"
  ./Configure -sde -Dhintfile=emscripten -Dusedevel 2>&1 | tail -5
  grep "^d_perl_lc_all_uses\|^d_setlocale" config.sh

  echo "==> [cross] make perl (RUN_PERL = native miniperl; utilities skipped)"
  set +e
  make -j"$NPROC" perl RUN_PERL="$native/miniperl -Ilib -I." > make.log 2>&1
  local rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    echo "==> [cross] make FAILED (rc=$rc); errors:"
    # btparse ships files literally named error.c/error.h — exclude that
    # warning noise or it drowns the real failure.
    grep -nE "error:|Error [0-9]|Unsuccessful|undefined symbol|No rule" make.log \
      | grep -vE "Werror|error\.[ch]" | head -25
    exit $rc
  fi
  tail -3 make.log

  echo "==> [cross] artifacts:"
  ls -la perl libperl.a 2>/dev/null || ls -la miniperl* libperl* 2>/dev/null || true
}

stage_libxml2() {
  local dir="$BUILD/libxml2-src"
  local out="$BUILD/wasm-libs/libxml2"
  if [ -f "$out/lib/libxml2.a" ]; then
    echo "==> [libxml2] up to date"; return 0
  fi
  local tarball="$BUILD/libxml2-$LIBXML2_VERSION.tar.xz"
  [ -f "$tarball" ] || bash "$ROOT/scripts/fetch-verify.sh" "$tarball" "$LIBXML2_SHA256" "${LIBXML2_URLS[@]}"
  rm -rf "$dir" && mkdir -p "$dir" "$out"
  tar -xJf "$tarball" -C "$dir" --strip-components=1
  cd "$dir"
  source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1
  # UTF-8-only documents (.bcf control files): no iconv/icu, no python, no
  # compression, no threads. Static archive for the perl link.
  emconfigure ./configure --host=wasm32-emscripten --prefix="$out" \
    --disable-shared --enable-static --without-python --without-zlib \
    --without-lzma --without-iconv --with-icu=no --without-threads \
    --without-debug > configure.log 2>&1 || { tail -20 configure.log; exit 1; }
  emmake make -j"$NPROC" install > make.log 2>&1 || { tail -20 make.log; exit 1; }
  echo "==> [libxml2] $(ls -la "$out/lib/libxml2.a" | awk '{print $5}') bytes"
}

# Fetch the step-2 XS dist tarballs; stage cross unpacks them into the
# perl tree's ext/ (Configure only sees ext/ members present at Configure
# time, and cross wipes the tree — so staging lives there).
stage_xs_fetch() {
  local tb="$BUILD/Text-BibTeX-$TEXTBIBTEX_VERSION.tar.gz"
  [ -f "$tb" ] || bash "$ROOT/scripts/fetch-verify.sh" "$tb" "$TEXTBIBTEX_SHA256" "${TEXTBIBTEX_URLS[@]}"
  local xl="$BUILD/XML-LibXML-$XMLLIBXML_VERSION.tar.gz"
  [ -f "$xl" ] || bash "$ROOT/scripts/fetch-verify.sh" "$xl" "$XMLLIBXML_SHA256" "${XMLLIBXML_URLS[@]}"
  local sk="$BUILD/Sort-Key-$SORTKEY_VERSION.tar.gz"
  [ -f "$sk" ] || bash "$ROOT/scripts/fetch-verify.sh" "$sk" "$SORTKEY_SHA256" "${SORTKEY_URLS[@]}"
  local av="$BUILD/autovivification-$AUTOVIV_VERSION.tar.gz"
  [ -f "$av" ] || bash "$ROOT/scripts/fetch-verify.sh" "$av" "$AUTOVIV_SHA256" "${AUTOVIV_URLS[@]}"
  local ul="$BUILD/Unicode-LineBreak-$ULB_VERSION.tar.gz"
  [ -f "$ul" ] || bash "$ROOT/scripts/fetch-verify.sh" "$ul" "$ULB_SHA256" "${ULB_URLS[@]}"
  local dt="$BUILD/DateTime-$DATETIME_VERSION.tar.gz"
  [ -f "$dt" ] || bash "$ROOT/scripts/fetch-verify.sh" "$dt" "$DATETIME_SHA256" "${DATETIME_URLS[@]}"
  local cl="$BUILD/Clone-$CLONE_VERSION.tar.gz"
  [ -f "$cl" ] || bash "$ROOT/scripts/fetch-verify.sh" "$cl" "$CLONE_SHA256" "${CLONE_URLS[@]}"
  echo "==> [xs] tarballs fetched; run stage cross to build them in"
}

# Stage the biber dist itself. Its pure-perl dependency tree is already in
# place: stage purelib installs the whole locked closure (cpan-lock.txt).
stage_biber() {
  local purelib="$BUILD/purelib"
  [ -d "$purelib/lib/perl5" ] || { echo "run stage purelib first" >&2; exit 1; }

  local bt="$BUILD/biblatex-biber-$BIBER_VERSION.tar.gz"
  [ -f "$bt" ] || bash "$ROOT/scripts/fetch-verify.sh" "$bt" "$BIBER_SHA256" "${BIBER_URLS[@]}"
  rm -rf "$BUILD/biber-dist" && mkdir -p "$BUILD/biber-dist"
  tar -xzf "$bt" -C "$BUILD/biber-dist" --strip-components=1

  # XML::LibXML::Simple is one pure .pm whose dep tree would drag cpanm
  # into building XML::LibXML natively — stage the file directly.
  local xs="$BUILD/XML-LibXML-Simple-$XLSIMPLE_VERSION.tar.gz"
  [ -f "$xs" ] || bash "$ROOT/scripts/fetch-verify.sh" "$xs" "$XLSIMPLE_SHA256" "${XLSIMPLE_URLS[@]}"
  local tmp
  tmp=$(mktemp -d)
  tar -xzf "$xs" -C "$tmp" --strip-components=1
  mkdir -p "$purelib/lib/perl5/XML/LibXML"
  cp "$tmp/lib/XML/LibXML/Simple.pm" "$purelib/lib/perl5/XML/LibXML/"
  rm -rf "$tmp"

  echo "==> [biber] dist staged (deps: $(find "$purelib/lib/perl5" -name '*.pm' | wc -l) modules from the lock)"
}

stage_biber_smoke() {
  cd "$BUILD/perl-emcc-src"
  cp -f perl perl.cjs
  echo "==> [biber-smoke] biber --version under wasm perl"
  node perl.cjs -Ilib "-I$BUILD/purelib/lib/perl5" "-I$BUILD/biber-dist/lib" \
    "$BUILD/biber-dist/bin/biber" --version
  echo "    (exit $?)"
}

# M4 packaging: install the cross perl into a staging prefix, merge the
# pure-perl trees, prune aggressively, pack biber-vfs.tar.gz, and produce
# the BROWSER artifact (MODULARIZE/EXPORT_ES6 link matching the engine
# conventions in targets/emscripten.mk) at build/biber/emscripten/.
stage_dist() {
  local src="$BUILD/perl-emcc-src"
  local native="$BUILD/native"
  local stage="$BUILD/vfs-stage"
  local out="$BUILD/emscripten"
  [ -x "$src/perl" ] || { echo "run stage cross first" >&2; exit 1; }
  source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1

  echo "==> [dist] installperl (direct — make install would build utilities)"
  rm -rf "$stage" && mkdir -p "$stage" "$out"
  (cd "$src" && "$native/miniperl" -Ilib installperl --destdir="$stage" > install.log 2>&1) \
    || { tail -15 "$src/install.log"; exit 1; }

  echo "==> [dist] merging purelib + biber into site_perl"
  local site="$stage/perl/lib/site_perl/5.42.0"
  mkdir -p "$site"
  cp -rn "$BUILD/purelib/lib/perl5/." "$site/"
  cp -rn "$BUILD/biber-dist/lib/." "$site/"
  # site_perl precedes the core lib in @INC, and the purelib contains PURE
  # copies of dists we compiled statically (cpanm --pp installed e.g. a
  # Clone.pm whose XSLoader can only fail). Core must win: drop any site
  # module that also exists in the core lib — INCLUDING the archlib subdir,
  # where installperl puts static-ext .pm files (compare with the arch
  # segment stripped or nothing matches).
  local archname=wasm32-emscripten-64int
  (cd "$stage/perl/lib/5.42.0" && {
    find . -name '*.pm'
    [ -d "$archname" ] && (cd "$archname" && find . -name '*.pm')
  } | sort -u | while read -r pm; do
    rm -f "$site/$pm"
  done)
  mkdir -p "$stage/biber/bin"
  cp "$BUILD/biber-dist/bin/biber" "$stage/biber/bin/"
  # Biber loads its datamodel/recode data via relative dist paths or
  # File::ShareDir — ship data/ next to the lib tree both ways.
  if [ -d "$BUILD/biber-dist/data" ]; then
    mkdir -p "$site/auto/share/dist/biblatex-biber"
    cp -rn "$BUILD/biber-dist/data/." "$site/auto/share/dist/biblatex-biber/"
  fi

  echo "==> [dist] pruning"
  rm -rf "$stage/perl/bin" "$stage/perl/man" 2>/dev/null || true
  find "$stage" -name '*.pod' -delete
  find "$stage" -name '.packlist' -delete
  find "$stage" -name '*.h' -path '*/CORE/*' -delete
  find "$stage" -type d -name man -prune -exec rm -rf {} + 2>/dev/null || true
  find "$stage" -type d -empty -delete
  du -sh "$stage"

  echo "==> [dist] packing biber-vfs.tar.gz"
  tar -C "$stage" -czf "$out/biber-vfs.tar.gz" perl biber
  ls -la "$out/biber-vfs.tar.gz"

  echo "==> [dist] browser link (MODULARIZE, engine conventions)"
  (cd "$src" && emcc -O2 -o "$out/biber.js" \
    -sSUPPORT_LONGJMP=emscripten \
    -sALLOW_MEMORY_GROWTH=1 \
    -sMEMORY_GROWTH_GEOMETRIC_STEP=0.5 \
    -sINITIAL_MEMORY=67108864 \
    -sMAXIMUM_MEMORY=$MAX_MEMORY \
    -sSTACK_SIZE=8388608 \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sEXPORTED_RUNTIME_METHODS=FS,callMain,PATH,HEAPU8,HEAPU32 \
    -sEXPORTED_FUNCTIONS=_main,_malloc,_free \
    -sENVIRONMENT=worker,web,node \
    -sFORCE_FILESYSTEM=1 \
    -sEXIT_RUNTIME=0 \
    -sINVOKE_RUN=0 \
    perlmain.o $(cat "$src/static.list" 2>/dev/null || ls lib/auto/*/*.a lib/auto/*/*/*.a lib/auto/*/*/*/*.a 2>/dev/null | tr '\n' ' ') libperl.a $(cat "$src/ext.libs") -lm)
  ls -la "$out/biber.js" "$out/biber.wasm"
}

# Browser-artifact smoke: instantiate the MODULARIZE factory in Node,
# populate MEMFS from biber-vfs.tar.gz exactly like src/core/worker.ts
# does, run --version and the roundtrip fixture fully in-memory.
stage_dist_smoke() {
  node "$SCRIPTS/dist-smoke.mjs" "$BUILD"
}

# Step 4: authentic .bcf (made by OUR pdflatex.wasm) → wasm biber → .bbl,
# byte-diffed against native biber, timed against the spike criteria.
stage_roundtrip() {
  local rt="$BUILD/roundtrip"
  rm -rf "$rt" && mkdir -p "$rt"
  node "$SCRIPTS/gen-bcf.mjs" "$rt"

  cd "$BUILD/perl-emcc-src"
  cp -f perl perl.cjs
  echo "==> [roundtrip] wasm biber run"
  local t0 t1
  t0=$(date +%s%N)
  set +e
  node perl.cjs -Ilib "-I$BUILD/purelib/lib/perl5" "-I$BUILD/biber-dist/lib" \
    "$BUILD/biber-dist/bin/biber" --noconf --input-directory "$rt" \
    --output-directory "$rt" --output-file test-wasm.bbl test 2>&1 | tail -8
  local rc=$?
  set -e
  t1=$(date +%s%N)
  echo "==> [roundtrip] wasm biber: exit=$rc, $(( (t1 - t0) / 1000000 )) ms"
  [ -s "$rt/test-wasm.bbl" ] || { echo "no .bbl produced" >&2; exit 1; }

  echo "==> [roundtrip] native biber (golden reference)"
  if ! command -v biber >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1
    apt-get install -qq -y --no-install-recommends biber >/dev/null 2>&1
  fi
  (cd "$rt" && biber --noconf --output-file test-native.bbl test >/dev/null 2>&1) || true
  if [ -s "$rt/test-native.bbl" ]; then
    if diff -q "$rt/test-wasm.bbl" "$rt/test-native.bbl" >/dev/null; then
      echo "==> [roundtrip] .bbl IDENTICAL to native biber"
    else
      echo "==> [roundtrip] .bbl differs from native ($(diff "$rt/test-wasm.bbl" "$rt/test-native.bbl" | wc -l) diff lines; native is $(biber --version))"
      diff "$rt/test-wasm.bbl" "$rt/test-native.bbl" | head -20
    fi
  else
    echo "==> [roundtrip] native biber unavailable — skipping diff"
  fi
  echo "==> [roundtrip] sizes: perl.wasm $(stat -c%s perl.wasm) bytes, purelib $(du -sh "$BUILD/purelib" | cut -f1), biber-dist $(du -sh "$BUILD/biber-dist" | cut -f1)"
}

stage_xs_smoke() {
  cd "$BUILD/perl-emcc-src"
  cp -f perl perl.cjs
  local inc=(-Ilib "-I$BUILD/purelib/lib/perl5")
  echo "==> [xs-smoke] XML::LibXML parses a .bcf-ish document"
  node perl.cjs "${inc[@]}" -e 'use XML::LibXML; my $doc = XML::LibXML->load_xml(string => q{<bcf:controlfile xmlns:bcf="https://sourceforge.net/projects/biblatex"><bcf:datamodel><bcf:entrytype>article</bcf:entrytype></bcf:datamodel></bcf:controlfile>}); my ($n) = $doc->documentElement->getElementsByTagName("bcf:entrytype"); print "bcf ok: ", $n->textContent, "\n"'
  echo "==> [xs-smoke] Text::BibTeX parses a .bib entry"
  node perl.cjs "${inc[@]}" -e 'use Text::BibTeX; my $e = Text::BibTeX::Entry->new({ binmode => "utf-8" }); $e->parse_s(q{@book{knuth, author = {Donald E. Knuth}, title = {TAOCP}}}); print "bib ok: ", $e->get("author"), "\n"'
}

stage_smoke() {
  cd "$BUILD/perl-emcc-src"
  # Extensionless emcc glue confuses Node's CJS/ESM guesser — run via .cjs.
  cp -f perl perl.cjs
  run_one() {
    echo "==> [smoke] $1"
    shift
    set +e
    node perl.cjs "$@"
    local code=$?
    set -e
    echo "    (exit $code)"
  }
  run_one "--version" --version
  run_one "-e hello" -e 'my @xs = grep { $_ } (1, 0, "wasm"); print "hello from perl-$] on wasm32-emscripten: @xs\n"'
  run_one "eval/die (setjmp-longjmp round trip)" -e 'my $r = eval { die "boom\n"; 1 }; print defined $r ? "MISSED\n" : "caught: $@"'
  run_one "regex + unicode internals" -e 'my $s = "K\x{f8}n"; print "match\n" if $s =~ /K.n/'
}

case "$STAGE" in
  native)      stage_native ;;
  purelib)     stage_purelib ;;
  cpan-lock)   stage_cpan_lock ;;
  cross)       stage_cross ;;
  smoke)       stage_smoke ;;
  libxml2)     stage_libxml2 ;;
  xs-fetch)    stage_xs_fetch ;;
  xs-smoke)    stage_xs_smoke ;;
  biber)       stage_biber ;;
  biber-smoke) stage_biber_smoke ;;
  roundtrip)   stage_roundtrip ;;
  dist)        stage_dist ;;
  dist-smoke)  stage_dist_smoke ;;
  all)         stage_native && stage_cross && stage_smoke ;;
  *) echo "unknown stage: $STAGE (native|purelib|cpan-lock|cross|smoke|libxml2|xs-fetch|xs-smoke|biber|biber-smoke|all)" >&2; exit 1 ;;
esac
