# Top-level driver for the engine build.
#
# Designed to be invoked inside the Docker container from `engine/Dockerfile`,
# but also runs natively if EMSDK / WASI_SDK_PATH are set.
#
# Targets:
#   make all                  # all engines, both targets
#   make pdflatex             # just pdflatex.wasm (emscripten + wasi)
#   make pdflatex-emscripten  # one engine, one target
#   make clean
#
# Build outputs:
#   build/<engine>/<target>/<engine>.wasm
#   build/<engine>/<target>/<engine>.js          (emscripten only)
#   dist/<engine>/<target>/<engine>.wasm         (after `make dist`)
#
# The TL source is pulled into source/texlive-source/ as a git submodule,
# pinned to our hard-forked tag.

SHELL := /bin/bash

ROOT       := $(CURDIR)
SOURCE_DIR := $(ROOT)/source
BUILD_DIR  := $(ROOT)/build
DIST_DIR   := $(ROOT)/dist
PATCHES    := $(ROOT)/patches

# Engines we build for v1.
ENGINES_V1 := pdflatex xelatex lualatex bibtexu xdvipdfmx makeindex synctex

# Build targets.
TARGETS := emscripten wasi

# Pinned TL fork (set in submodule config; this is just a marker).
TL_FORK_TAG ?= texlive-wasm-2026.0

# Build flags shared across engines.
include targets/common.mk

# Native helper tools required before cross-compile.
include targets/native.mk

# Native ICU pre-build for engines that link against libicu (xelatex, bibtexu).
include targets/icu-native.mk

# Wasm fontconfig + expat + freetype (for xelatex).
include targets/fontconfig-wasm.mk

# Per-target rules.
include targets/emscripten.mk
include targets/wasi.mk

# --------------------------------------------------------------------- top-level

.PHONY: all
all: $(foreach e,$(ENGINES_V1),$(foreach t,$(TARGETS),$(e)-$(t)))

.PHONY: $(ENGINES_V1)
$(ENGINES_V1): %: $(addprefix %-,$(TARGETS))

.PHONY: source
source: $(SOURCE_DIR)/texlive-source/.unpacked

$(SOURCE_DIR)/texlive-source/.unpacked:
	@echo "==> Setting up TL source"
	@mkdir -p $(SOURCE_DIR)
	@if [ ! -d $(ROOT)/../vendor/texlive-source/.git ] && [ ! -f $(ROOT)/../vendor/texlive-source/.git ]; then \
	  cd $(ROOT)/.. && git submodule update --init --recursive vendor/texlive-source; \
	fi
	@ln -sfn $(ROOT)/../vendor/texlive-source $(SOURCE_DIR)/texlive-source
	@echo "==> Patching TL source (idempotent)"
	@$(ROOT)/scripts/patch-icu-makefile.sh $(ROOT)/../vendor/texlive-source/libs/icu/Makefile.in
	@# ICU has no mh-wasm32-emscripten; the fallback `mh-unknown` is a stub
	@# that prints "could not detect platform". Emscripten is Linux-like, so
	@# copy mh-linux over mh-unknown.
	@if ! grep -q 'wasm32-emscripten-patched' $(ROOT)/../vendor/texlive-source/libs/icu/icu-src/source/config/mh-unknown; then \
	  cp $(ROOT)/../vendor/texlive-source/libs/icu/icu-src/source/config/mh-linux \
	     $(ROOT)/../vendor/texlive-source/libs/icu/icu-src/source/config/mh-unknown; \
	  echo "# wasm32-emscripten-patched" >> $(ROOT)/../vendor/texlive-source/libs/icu/icu-src/source/config/mh-unknown; \
	  echo "==> Patched mh-unknown with mh-linux content"; \
	fi
	@touch $@

.PHONY: clean
clean:
	rm -rf $(BUILD_DIR) $(DIST_DIR)

.PHONY: distclean
distclean: clean
	rm -rf $(SOURCE_DIR)

# Pack the built artifacts into a dist/ tree that the npm package will pick up.
.PHONY: dist
dist: all
	@mkdir -p $(DIST_DIR)
	@for e in $(ENGINES_V1); do \
	  for t in $(TARGETS); do \
	    mkdir -p $(DIST_DIR)/$$e/$$t; \
	    cp -p $(BUILD_DIR)/$$e/$$t/$$e.wasm $(DIST_DIR)/$$e/$$t/ 2>/dev/null || true; \
	    cp -p $(BUILD_DIR)/$$e/$$t/$$e.js   $(DIST_DIR)/$$e/$$t/ 2>/dev/null || true; \
	  done; \
	done
	@echo "==> Dist tree:" && find $(DIST_DIR) -type f -name '*.wasm' -o -name '*.js' | sort

# Post-process artifacts: brotli + gzip pre-compression for static-host serving.
# Idempotent; safe to re-run.
.PHONY: optimize
optimize:
	@bash $(ROOT)/scripts/optimize-wasm.sh
