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

PERL_VERSION=5.42.0
PERL_SHA256=e093ef184d7f9a1b9797e2465296f55510adb6dab8842b0c3ed53329663096dc
PERL_URLS=(
  "https://www.cpan.org/src/5.0/perl-$PERL_VERSION.tar.gz"
  "https://cpan.metacpan.org/src/5.0/perl-$PERL_VERSION.tar.gz"
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

# Pure-perl runtime deps, staged with the NATIVE perl's cpanm into a lib
# tree the wasm perl reads via -I (pure perl is architecture-independent).
# Spike-scope: unpinned cpanm installs; the production M4 build will pin.
stage_purelib() {
  local native="$BUILD/native"
  local purelib="$BUILD/purelib"
  local nperl="$native/prefix/bin/perl"
  [ -x "$nperl" ] || { echo "run stage native first" >&2; exit 1; }
  if [ ! -x "$native/prefix/bin/cpanm" ]; then
    echo "==> [purelib] installing cpanminus into the native perl"
    curl -fsSL https://cpanmin.us | "$nperl" - --notest App::cpanminus >/dev/null
  fi
  # NOTE: never list dists here whose dep tree includes XML::LibXML — cpanm
  # would try to build it natively; the wasm perl has it statically.
  # (XML::LibXML::Simple is staged file-wise in the biber stage instead.)
  "$native/prefix/bin/cpanm" -L "$purelib" --notest \
    XML::SAX XML::NamespaceSupport 2>&1 | tail -3
  echo "==> [purelib] $(find "$purelib/lib/perl5" -name '*.pm' | wc -l) modules staged"
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
    grep -iE "error|undefined symbol" make.log | grep -vE "Werror|-Wno-|encoding-warnings" | head -30
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
  echo "==> [xs] tarballs fetched; run stage cross to build them in"
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
  native)   stage_native ;;
  purelib)  stage_purelib ;;
  cross)    stage_cross ;;
  smoke)    stage_smoke ;;
  libxml2)  stage_libxml2 ;;
  xs-fetch) stage_xs_fetch ;;
  xs-smoke) stage_xs_smoke ;;
  all)      stage_native && stage_cross && stage_smoke ;;
  *) echo "unknown stage: $STAGE (native|purelib|cross|smoke|libxml2|xs-fetch|xs-smoke|all)" >&2; exit 1 ;;
esac
