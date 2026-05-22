# Native ICU pre-build for xelatex / bibtexu cross-compile.
#
# ICU's cross-compile mode runs native data-generation tools (pkgdata,
# icupkg, genccode, genrb, gencmn, ...) at make time. Those must already
# exist as native ELF binaries; otherwise the cross-build dies with
# "match-arch file foo.obj is not an ELF object file".
#
# We do a standalone ICU configure+make directly against ICU's own source
# (vendor/texlive-source/libs/icu/icu-src/source/) — bypassing TL's libs/icu
# wrapper, which would also want to build the wasm cross-side that we don't
# need here.
#
# The result is symlinked into each xelatex/bibtexu cross-build's expected
# `icu-native/` location by engine/targets/emscripten.mk.

ICU_NATIVE_DIR  := $(BUILD_DIR)/icu-native
ICU_NATIVE_SRC  := $(TL_SOURCE)/libs/icu/icu-src/source
ICU_NATIVE_DONE := $(ICU_NATIVE_DIR)/.built

# Binaries we depend on the native ICU producing. pkgdata + the gen* tools
# are the ones TL invokes from the cross-build.
ICU_NATIVE_BINS := pkgdata icupkg genccode genrb gencmn gencfu gennorm2 makeconv genbrk gensprep

.PHONY: icu-native
icu-native: $(ICU_NATIVE_DONE)

$(ICU_NATIVE_DONE): | source
	@echo "==> [icu-native] configure (host-only, plain gcc)"
	@mkdir -p $(ICU_NATIVE_DIR)
	@cd $(ICU_NATIVE_DIR) && \
	  CC=gcc CXX=g++ AR=ar RANLIB=ranlib \
	  $(ICU_NATIVE_SRC)/configure \
	    --enable-static --disable-shared \
	    --disable-extras --disable-samples --disable-tests \
	    --disable-dyload --disable-layout --disable-strict \
	    --disable-icuio \
	    --build=x86_64-pc-linux-gnu --host=x86_64-pc-linux-gnu \
	    > configure.log 2>&1 \
	  || (echo "==> [icu-native] configure FAILED"; tail -30 configure.log; exit 1)
	@echo "==> [icu-native] make"
	@cd $(ICU_NATIVE_DIR) && \
	  $(MAKE) -j$(shell nproc 2>/dev/null || echo 2) \
	    > make.log 2>&1 \
	  || (echo "==> [icu-native] make FAILED"; tail -30 make.log; exit 1)
	@echo "==> [icu-native] verifying bins"
	@missing=""; \
	for b in $(ICU_NATIVE_BINS); do \
	  test -x $(ICU_NATIVE_DIR)/bin/$$b || missing="$$missing $$b"; \
	done; \
	if [ -n "$$missing" ]; then \
	  echo "==> [icu-native] MISSING:$$missing"; \
	  exit 1; \
	fi; \
	echo "==> [icu-native] ALL bins built"
	@touch $@
