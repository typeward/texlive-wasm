#!/bin/sh
#
# Patch a generated libs/icu/Makefile to force native gcc for the icu-native
# sub-config.
#
# TL's libs/icu/Makefile contains two `eval $(SHELL) $$cmd` lines:
#   - one for icu-build  (the cross-compile, should use our wrapped emcc)
#   - one for icu-native (the host-tools build, MUST use native gcc)
#
# We only patch the second one by scoping the substitution to lines between
# `icu-native/Makefile:` and the next blank line.
#
# Usage:
#   patch-icu-makefile.sh <path-to-libs/icu/Makefile>

set -eu

target="$1"
[ -f "$target" ] || { echo "$0: $target not found" >&2; exit 1; }

python3 - "$target" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path).read()
# Find the icu-native/Makefile rule and rewrite its eval line.
pattern = re.compile(
    r'(^icu-native/Makefile:\n(?:.+\n)*?\s+)eval \$\(SHELL\) \$\$cmd(\))',
    re.MULTILINE,
)
replacement = (
    r'\1eval env -u CXX -u AR -u RANLIB -u LD '
    r'CC=gcc CXX=g++ AR=ar RANLIB=ranlib '
    r'$(SHELL) $$cmd\2'
)
# Idempotent — if the file already contains our prefix, skip silently.
if 'CC=gcc CXX=g++ AR=ar RANLIB=ranlib $(SHELL) $$cmd' in src:
    print(f"already patched: {path}")
    sys.exit(0)
new, count = pattern.subn(replacement, src)
if count == 0:
    print(f"{sys.argv[0]}: pattern not found in {path}", file=sys.stderr)
    sys.exit(1)
open(path, 'w').write(new)
print(f"patched {count} occurrence(s) in {path}")
PY
