#!/usr/bin/env bash
#
# download-tl-source.sh — bootstrap the TL source for a fresh checkout.
#
# Idempotent. Run once after cloning the repo, or when the pinned tag changes.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d vendor/texlive-source/.git ]; then
  echo "==> Initializing vendor/texlive-source submodule"
  git submodule update --init --recursive vendor/texlive-source
fi

echo "==> texlive-source is ready at: $(git -C vendor/texlive-source describe --always)"
