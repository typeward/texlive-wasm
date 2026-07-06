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

  # Install our hints with paths substituted.
  sed -e "s|__PERLCC__|$SCRIPTS/perlcc|g" \
      -e "s|__NATIVE_DIR__|$native|g" \
      "$SCRIPTS/hints-emscripten.sh" > hints/emscripten.sh
  chmod +x "$SCRIPTS/perlcc"

  echo "==> [cross] Configure (hints: emscripten)"
  ./Configure -sde -Dhintfile=emscripten -Dusedevel 2>&1 | tail -5

  echo "==> [cross] make (RUN_PERL = native miniperl)"
  make -j"$NPROC" RUN_PERL="$native/miniperl -Ilib -I." 2>&1 | tail -15

  echo "==> [cross] artifacts:"
  ls -la perl libperl.a 2>/dev/null || ls -la miniperl* libperl* 2>/dev/null || true
}

case "$STAGE" in
  native) stage_native ;;
  cross)  stage_cross ;;
  all)    stage_native && stage_cross ;;
  *) echo "unknown stage: $STAGE (native|cross|all)" >&2; exit 1 ;;
esac
