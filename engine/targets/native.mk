# Native target — builds the host helper binaries TL needs during cross-compile.
#
# TL's web2c subsystem uses Pascal-WEB sources that get translated to C by
# tools like `tangle` and `tangleboot`. When cross-compiling, those tools must
# already exist as native executables; otherwise the cross-build can't even
# generate its C sources to compile.
#
# We do a minimal native ./configure + make of TL just enough to get the
# helper binaries. The emcc_wrapper.py then substitutes them at link time
# whenever the cross-build asks emcc to "produce" a tangleboot/etc.
#
# Helper binaries produced (relative to NATIVE_BUILD/Work):
#   texk/web2c/{tangle, ctangle, otangle, tangleboot, ctangleboot, tie}
#   texk/web2c/web2c/{web2c, fixwrites, makecpool, splitup}

NATIVE_BUILD := $(BUILD_DIR)/native

# List of helper binaries we need on the host side. These exact basenames are
# what emcc_wrapper.py matches against during the wasm link.
#
# `otangle` is only built with --enable-aleph (Omega engine). pdftex doesn't
# invoke otangle at runtime, but TL's configure unconditionally checks for it
# when cross-compiling, so we install a /bin/true stub after the native build.
NATIVE_HELPERS_TEXK := tangle ctangle tangleboot ctangleboot tie
NATIVE_HELPERS_W2C  := web2c fixwrites makecpool splitup
NATIVE_HELPER_STUBS_TEXK := otangle

# Marker file we touch once the helpers are built; downstream rules depend on this.
NATIVE_DONE := $(NATIVE_BUILD)/.helpers_built

# Configure options for the native build. We want a *fast* configure — just
# enough to make the web2c subdir buildable. Disable every engine and every
# package we don't need at native time.
TL_NATIVE_CONFIGURE := \
	--disable-shared \
	--disable-largefile \
	--disable-all-pkgs \
	--enable-web2c \
	--enable-tex \
	--enable-pdftex \
	--enable-omfonts=no \
	--disable-luajittex \
	--disable-luajithbtex \
	--disable-luatex \
	--disable-luahbtex \
	--disable-xetex \
	--disable-ptex \
	--disable-eptex \
	--disable-uptex \
	--disable-euptex \
	--disable-aleph \
	--disable-mflua \
	--disable-mfluajit \
	--disable-mp \
	--disable-mmetapost \
	--without-x \
	--without-iconv

.PHONY: native-helpers
native-helpers: $(NATIVE_DONE)

$(NATIVE_DONE): | source
	@echo "==> [native] configure"
	@mkdir -p $(NATIVE_BUILD)/Work
	@cd $(NATIVE_BUILD)/Work && \
	  $(TL_SOURCE)/configure \
	    $(TL_NATIVE_CONFIGURE) \
	    CFLAGS="-O2" CXXFLAGS="-O2" \
	    > configure.log 2>&1 \
	  || (echo "==> [native] configure FAILED"; tail -40 configure.log; exit 1)
	@echo "==> [native] make helpers"
	@cd $(NATIVE_BUILD)/Work && \
	  $(MAKE) -j$(shell nproc 2>/dev/null || echo 2) \
	    > make.log 2>&1 \
	  || (echo "==> [native] make FAILED"; tail -40 make.log; exit 1)
	@echo "==> [native] verifying helpers"
	@missing=""; \
	for h in $(NATIVE_HELPERS_TEXK); do \
	  test -x $(NATIVE_BUILD)/Work/texk/web2c/$$h || missing="$$missing $$h"; \
	done; \
	for h in $(NATIVE_HELPERS_W2C); do \
	  test -x $(NATIVE_BUILD)/Work/texk/web2c/web2c/$$h || missing="$$missing $$h"; \
	done; \
	if [ -n "$$missing" ]; then \
	  echo "==> [native] MISSING helpers:$$missing"; \
	  exit 1; \
	fi; \
	echo "==> [native] installing stubs (only if missing) ($(NATIVE_HELPER_STUBS_TEXK))"; \
	for h in $(NATIVE_HELPER_STUBS_TEXK); do \
	  if [ -x $(NATIVE_BUILD)/Work/texk/web2c/$$h ]; then \
	    echo "  (real $$h exists, keeping)"; \
	    continue; \
	  fi; \
	  printf '%s\n' \
	    '#!/bin/sh' \
	    '# Stub: satisfies TL configure WEBINPUTS check when omegaware is disabled.' \
	    'cp "$$WEBINPUTS/ocftest.p" cftest.p 2>/dev/null || true' \
	    > $(NATIVE_BUILD)/Work/texk/web2c/$$h; \
	  chmod +x $(NATIVE_BUILD)/Work/texk/web2c/$$h; \
	done
	@echo "==> [native] helpers OK"
	@touch $@

# Comma-separated full paths to the helpers, for use in CC= wrapper invocations.
NATIVE_HELPER_PATHS = \
	$(foreach h,$(NATIVE_HELPERS_TEXK),$(NATIVE_BUILD)/Work/texk/web2c/$(h)) \
	$(foreach h,$(NATIVE_HELPERS_W2C),$(NATIVE_BUILD)/Work/texk/web2c/web2c/$(h))
