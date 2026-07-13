# biber.wasm — biber 2.19 on Perl 5.42, cross-compiled with Emscripten.
#
# The heavy lifting lives in scripts/biber/spike-build.sh (stage-driven and
# heavily annotated — every stage documents the trap it works around). This
# target just chains the stages for CI and local builds:
#
#   native    host perl (miniperl + full install)
#   purelib   the locked pure-perl closure (scripts/biber/cpan-lock.txt) via
#             a pinned cpanm, installed from a sha256-verified local mirror
#   libxml2   wasm static libxml2 for XML::LibXML
#   xs-fetch  pinned XS dist tarballs
#   cross     Perl + 7 static XS exts → libperl.a + perl (glue)
#   biber     biber dist (+ XML::LibXML::Simple)
#   dist      installperl → prune → biber-vfs.tar.gz + MODULARIZE link
#
# `spike-build.sh cpan-lock` regenerates the lock against live CPAN. It is
# deliberately NOT part of this chain: builds must be lock-driven.
#
# Output: build/biber/emscripten/{biber.js,biber.wasm,biber-vfs.tar.gz}
#
# The pinned biber version is LOCKSTEPPED to the TDS biblatex version
# (scripts/check-biber-lockstep.mjs enforces the pairing in CI).

BIBER_STAGES := native purelib libxml2 xs-fetch cross biber dist

.PHONY: biber-emscripten
biber-emscripten:
	@for s in $(BIBER_STAGES); do \
	  bash $(ROOT)/scripts/biber/spike-build.sh $$s || exit 1; \
	done
	@bash $(ROOT)/scripts/biber/spike-build.sh dist-smoke

# No WASI leg: the artifact targets the browser/worker runtime.
.PHONY: biber-wasi
biber-wasi:
	@echo "biber-wasi: not built (emscripten-only artifact)"
