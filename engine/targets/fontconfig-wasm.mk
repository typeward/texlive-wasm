# Wasm fontconfig build for xelatex.
#
# XeTeX's XeTeXFontMgr_FC.cpp includes <fontconfig/fontconfig.h>. We build
# fontconfig + its expat dependency as separate wasm static libs, here.
#
# Pinned versions:
#   expat       2.6.4 (released 2024) — small XML parser, CMake build.
#   fontconfig  2.15.0 (released 2023) — autotools build, needs expat + freetype.
#
# The cross-compile of fontconfig also needs freetype2, but TL already builds
# that in libs/freetype2/ as part of each xelatex cross-build. So fontconfig
# is built AFTER libs/freetype2 inside the xelatex Work tree.
#
# For simplicity, we build expat + fontconfig in a *separate* shared dir
# (engine/build/wasm-libs/) so they're reused across xelatex builds.

WASM_LIBS_DIR := $(BUILD_DIR)/wasm-libs

# Tarballs are fetched by scripts/fetch-verify.sh: first mirror that works
# AND matches the pinned sha256 wins. freedesktop.org answers plain curl
# with HTTP 418 (anti-bot), hence the mirrors and the browser-ish UA there.

EXPAT_VERSION := 2.6.4
EXPAT_SHA256 := fd03b7172b3bd7427a3e7a812063f74754f24542429b634e0db6511b53fb2278
EXPAT_URLS := \
	https://github.com/libexpat/libexpat/releases/download/R_2_6_4/expat-$(EXPAT_VERSION).tar.gz
EXPAT_SRC := $(WASM_LIBS_DIR)/expat-$(EXPAT_VERSION)
EXPAT_BUILD := $(WASM_LIBS_DIR)/expat-build
EXPAT_LIB := $(EXPAT_BUILD)/libexpat.a
EXPAT_INCLUDE := $(EXPAT_SRC)/lib

FONTCONFIG_VERSION := 2.15.0
# .tar.xz (not .gz): the Debian orig tarball and the BLFS mirror carry the
# upstream xz archive, and both serve these exact bytes.
FONTCONFIG_SHA256 := 63a0658d0e06e0fa886106452b58ef04f21f58202ea02a94c39de0d3335d7c0e
FONTCONFIG_URLS := \
	https://www.freedesktop.org/software/fontconfig/release/fontconfig-$(FONTCONFIG_VERSION).tar.xz \
	https://deb.debian.org/debian/pool/main/f/fontconfig/fontconfig_$(FONTCONFIG_VERSION).orig.tar.xz \
	https://ftp.osuosl.org/pub/blfs/conglomeration/fontconfig/fontconfig-$(FONTCONFIG_VERSION).tar.xz
FONTCONFIG_SRC := $(WASM_LIBS_DIR)/fontconfig-$(FONTCONFIG_VERSION)
FONTCONFIG_BUILD := $(WASM_LIBS_DIR)/fontconfig-build
FONTCONFIG_LIB := $(FONTCONFIG_BUILD)/src/.libs/libfontconfig.a
FONTCONFIG_INCLUDE := $(FONTCONFIG_BUILD)/include

# fontconfig needs a freetype2 to link against. We use the one TL builds for
# us as part of the *xelatex* cross-build (libs/freetype2/). This means
# fontconfig-build can only happen AFTER libs/freetype2 is built.
# To avoid an inter-engine coupling, we instead build freetype2 in the
# wasm-libs/ dir too (small, ~3 min). Cleaner separation.
FREETYPE_VERSION := 2.13.3
FREETYPE_SHA256 := 5c3a8e78f7b24c20b25b54ee575d6daa40007a5f4eea2845861c3409b3021747
FREETYPE_URLS := \
	https://download.savannah.gnu.org/releases/freetype/freetype-$(FREETYPE_VERSION).tar.gz \
	https://download-mirror.savannah.gnu.org/releases/freetype/freetype-$(FREETYPE_VERSION).tar.gz
FREETYPE_SRC := $(WASM_LIBS_DIR)/freetype-$(FREETYPE_VERSION)
FREETYPE_BUILD := $(WASM_LIBS_DIR)/freetype-build
FREETYPE_LIB := $(FREETYPE_BUILD)/.libs/libfreetype.a
FREETYPE_INCLUDE := $(FREETYPE_SRC)/include

FETCH_VERIFY := bash $(ROOT)/scripts/fetch-verify.sh

WASM_LIBS_DONE := $(WASM_LIBS_DIR)/.built

.PHONY: wasm-libs
wasm-libs: $(WASM_LIBS_DONE)

# ---- expat (CMake build) ---------------------------------------------------

$(EXPAT_SRC)/.unpacked: | source
	@mkdir -p $(WASM_LIBS_DIR)
	@if [ ! -d $(EXPAT_SRC) ]; then \
	  echo "==> [wasm-libs] downloading expat $(EXPAT_VERSION)"; \
	  cd $(WASM_LIBS_DIR) && \
	  $(FETCH_VERIFY) expat.tar.gz $(EXPAT_SHA256) $(EXPAT_URLS) && \
	  tar -xf expat.tar.gz && \
	  rm expat.tar.gz; \
	fi
	@touch $@

$(EXPAT_LIB): $(EXPAT_SRC)/.unpacked
	@echo "==> [wasm-libs] expat configure + build"
	@mkdir -p $(EXPAT_BUILD)
	@cd $(EXPAT_BUILD) && \
	  source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1 && \
	  emcmake cmake $(EXPAT_SRC) \
	    -DCMAKE_BUILD_TYPE=MinSizeRel \
	    -DCMAKE_C_FLAGS="-Oz $(THREAD_CFLAGS) -D_GNU_SOURCE" \
	    -DEXPAT_BUILD_DOCS=OFF \
	    -DEXPAT_BUILD_EXAMPLES=OFF \
	    -DEXPAT_BUILD_FUZZERS=OFF \
	    -DEXPAT_BUILD_TESTS=OFF \
	    -DEXPAT_BUILD_TOOLS=OFF \
	    -DEXPAT_SHARED_LIBS=OFF \
	    -DEXPAT_BUILD_PKGCONFIG=OFF \
	    > cmake.log 2>&1 \
	  || (echo "==> [wasm-libs] expat cmake FAILED"; tail -30 cmake.log; exit 1)
	@cd $(EXPAT_BUILD) && \
	  source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1 && \
	  emmake $(MAKE) -j$(shell nproc 2>/dev/null || echo 2) > make.log 2>&1 \
	  || (echo "==> [wasm-libs] expat make FAILED"; tail -30 make.log; exit 1)
	@echo "==> [wasm-libs] expat OK"

# ---- freetype2 (autotools build) -------------------------------------------

$(FREETYPE_SRC)/.unpacked: | source
	@mkdir -p $(WASM_LIBS_DIR)
	@if [ ! -d $(FREETYPE_SRC) ]; then \
	  echo "==> [wasm-libs] downloading freetype $(FREETYPE_VERSION)"; \
	  cd $(WASM_LIBS_DIR) && \
	  $(FETCH_VERIFY) freetype.tar.gz $(FREETYPE_SHA256) $(FREETYPE_URLS) && \
	  tar -xf freetype.tar.gz && \
	  rm freetype.tar.gz; \
	fi
	@touch $@

$(FREETYPE_LIB): $(FREETYPE_SRC)/.unpacked
	@echo "==> [wasm-libs] freetype configure + build"
	@mkdir -p $(FREETYPE_BUILD)
	@cd $(FREETYPE_BUILD) && \
	  source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1 && \
	  emconfigure $(FREETYPE_SRC)/configure \
	    --host=wasm32-unknown-emscripten --build=x86_64-pc-linux-gnu \
	    --disable-shared --enable-static \
	    --without-zlib --without-bzip2 --without-png --without-harfbuzz --without-brotli \
	    CFLAGS="-Oz $(THREAD_CFLAGS)" \
	    > configure.log 2>&1 \
	  || (echo "==> [wasm-libs] freetype configure FAILED"; tail -30 configure.log; exit 1)
	@cd $(FREETYPE_BUILD) && \
	  source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1 && \
	  emmake $(MAKE) -j$(shell nproc 2>/dev/null || echo 2) > make.log 2>&1 \
	  || (echo "==> [wasm-libs] freetype make FAILED"; tail -30 make.log; exit 1)
	@echo "==> [wasm-libs] freetype OK"

# ---- fontconfig (autotools, depends on expat + freetype) -------------------

$(FONTCONFIG_SRC)/.unpacked: | source
	@mkdir -p $(WASM_LIBS_DIR)
	@if [ ! -d $(FONTCONFIG_SRC) ]; then \
	  echo "==> [wasm-libs] downloading fontconfig $(FONTCONFIG_VERSION)"; \
	  cd $(WASM_LIBS_DIR) && \
	  $(FETCH_VERIFY) fontconfig.tar.xz $(FONTCONFIG_SHA256) $(FONTCONFIG_URLS) && \
	  tar -xf fontconfig.tar.xz && \
	  rm fontconfig.tar.xz; \
	fi
	@touch $@

$(FONTCONFIG_LIB): $(FONTCONFIG_SRC)/.unpacked $(EXPAT_LIB) $(FREETYPE_LIB)
	@echo "==> [wasm-libs] fontconfig configure + build"
	@mkdir -p $(FONTCONFIG_BUILD)
	@# fontconfig 2.15.0 ships an older config.sub that doesn't know
	@# wasm32-emscripten. Use the newer one from the TL source tree.
	@if [ -f $(TL_SOURCE)/build-aux/config.sub ]; then \
	  cp $(TL_SOURCE)/build-aux/config.sub $(FONTCONFIG_SRC)/config.sub; \
	fi
	@cd $(FONTCONFIG_BUILD) && \
	  source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1 && \
	  PKG_CONFIG_LIBDIR=/dev/null \
	  emconfigure $(FONTCONFIG_SRC)/configure \
	    --host=wasm32-unknown-emscripten --build=x86_64-pc-linux-gnu \
	    --disable-shared --enable-static \
	    --disable-docs \
	    --with-expat-includes=$(EXPAT_INCLUDE) \
	    --with-expat-lib=$(EXPAT_BUILD) \
	    FREETYPE_CFLAGS="-I$(FREETYPE_INCLUDE)" \
	    FREETYPE_LIBS="$(FREETYPE_LIB)" \
	    CFLAGS="-Oz $(THREAD_CFLAGS) -D_GNU_SOURCE -Wno-error=implicit-function-declaration -Wno-error=int-conversion" \
	    CXXFLAGS="-Oz $(THREAD_CFLAGS) -D_GNU_SOURCE -Wno-error=implicit-function-declaration -Wno-error=int-conversion" \
	    ac_cv_func_random_r=no \
	    ac_cv_func_srandom_r=no \
	    ac_cv_func_initstate_r=no \
	    > configure.log 2>&1 \
	  || (echo "==> [wasm-libs] fontconfig configure FAILED"; tail -40 configure.log; exit 1)
	@echo "==> [wasm-libs] fontconfig: building libfontconfig.la only (skip tools)"
	@cd $(FONTCONFIG_BUILD) && \
	  source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1 && \
	  emmake $(MAKE) -j1 -C src fcalias.h fcaliastail.h fcftalias.h fcftaliastail.h fcstdint.h fcobjshash.h \
	    > make-headers.log 2>&1 \
	  || (echo "==> [wasm-libs] fontconfig header-gen FAILED"; tail -40 make-headers.log; exit 1); \
	  emmake $(MAKE) -j1 -C fc-case fccase.h > make-fccase.log 2>&1 || true; \
	  emmake $(MAKE) -j1 -C fc-lang fclang.h > make-fclang.log 2>&1 || true
	@cd $(FONTCONFIG_BUILD) && \
	  source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1 && \
	  emmake $(MAKE) -j$(shell nproc 2>/dev/null || echo 2) -C src libfontconfig.la \
	    > make.log 2>&1 \
	  || (echo "==> [wasm-libs] fontconfig make FAILED"; tail -40 make.log; exit 1)
	@echo "==> [wasm-libs] fontconfig OK"

# ---- Aggregate marker ------------------------------------------------------

$(WASM_LIBS_DONE): $(EXPAT_LIB) $(FREETYPE_LIB) $(FONTCONFIG_LIB)
	@touch $@
	@echo "==> [wasm-libs] all libs ready:"
	@echo "    expat:      $(EXPAT_LIB)"
	@echo "    freetype:   $(FREETYPE_LIB)"
	@echo "    fontconfig: $(FONTCONFIG_LIB)"
