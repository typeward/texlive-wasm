#!/bin/bash
#
# fetch-verify.sh <output-file> <sha256> <url> [mirror-url...]
#
# Downloads <output-file> from the first URL that works AND matches the
# pinned sha256. A browser-ish User-Agent is required because
# freedesktop.org answers plain curl with HTTP 418 (anti-bot), and the
# checksum pin keeps mirror fallbacks from being a supply-chain hole.

set -u

out="$1"
sha="$2"
shift 2

UA="Mozilla/5.0 (X11; Linux x86_64) texlive-wasm-build/1.0"

for url in "$@"; do
  echo "==> [fetch] $url"
  if curl -fsSL --retry 3 --retry-delay 2 -A "$UA" -o "$out" "$url"; then
    got=$(sha256sum "$out" | cut -d' ' -f1)
    if [ "$got" = "$sha" ]; then
      echo "==> [fetch] OK: $out (sha256 verified)"
      exit 0
    fi
    echo "==> [fetch] checksum mismatch from $url (got $got, want $sha)" >&2
    rm -f "$out"
  else
    echo "==> [fetch] download failed: $url" >&2
  fi
done

echo "==> [fetch] ERROR: could not fetch $out from any mirror" >&2
exit 1
