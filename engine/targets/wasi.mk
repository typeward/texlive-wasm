# WASI target — the Node / Wasmtime / edge build path.
#
# wasi-sdk gives us a single .wasm per engine that runs under any
# wasi-compliant runtime (Wasmtime, Wasmer, Node's --experimental-wasi).
#
# Status: experimental. The configure+make works for kpathsea + simple
# libs, but TL's web2c subsystem needs more porting work — fork/popen
# stubs differ from Emscripten's, signal handling differs, and there's no
# WASI equivalent of Emscripten's WASMFS abstraction.
#
# For v1, the Emscripten target is the production path; this WASI target
# is here so the toolchain is wired and we can iterate on it later.

CC_wasi   := $(WASI_SDK_PATH)/bin/clang
CXX_wasi  := $(WASI_SDK_PATH)/bin/clang++
AR_wasi   := $(WASI_SDK_PATH)/bin/llvm-ar
RANLIB_wasi := $(WASI_SDK_PATH)/bin/llvm-ranlib

WASI_SYSROOT := $(WASI_SDK_PATH)/share/wasi-sysroot

# Common compile flags.
WASI_CFLAGS := \
	$(OPT) \
	--target=wasm32-wasi \
	--sysroot=$(WASI_SYSROOT) \
	-I$(ROOT)/scripts/wasi-shims \
	-D_WASI_EMULATED_SIGNAL \
	-D_WASI_EMULATED_PROCESS_CLOCKS \
	-D_WASI_EMULATED_GETPID \
	-D_WASI_EMULATED_MMAN \
	-D_GNU_SOURCE \
	-Wno-error=implicit-function-declaration \
	-Wno-error=int-conversion \
	-mllvm -wasm-enable-sjlj \
	-include $(ROOT)/scripts/stubs_force.h

WASI_LDFLAGS := \
	-lwasi-emulated-signal \
	-lwasi-emulated-process-clocks \
	-lwasi-emulated-getpid \
	-lwasi-emulated-mman \
	-lsetjmp \
	-mllvm -wasm-enable-sjlj \
	-Wl,--initial-memory=67108864

# Only pdflatex is wired for WASI initially. Others are stubs.
WASI_CONFIGURABLE := pdflatex

define ENGINE_TEMPLATE_wasi
.PHONY: $(1)-wasi
$(1)-wasi: $$(BUILD_DIR)/$(1)/wasi/$(1).wasm

$$(BUILD_DIR)/$(1)/wasi/$(1).wasm: $$(NATIVE_DONE) | source
	@if ! echo "$$(WASI_CONFIGURABLE)" | grep -qw "$(1)"; then \
	  echo "==> [wasi] $(1) — not yet wired (only $$(WASI_CONFIGURABLE) supported); emitting stub"; \
	  mkdir -p $$(BUILD_DIR)/$(1)/wasi; \
	  touch $$@; \
	  exit 0; \
	fi; \
	echo "==> [wasi] $(1) — building libstubs.a"; \
	mkdir -p $$(BUILD_DIR)/$(1)/wasi; \
	$$(CC_wasi) $$(WASI_CFLAGS) -c $$(ROOT)/scripts/stubs.c -o $$(BUILD_DIR)/$(1)/wasi/stubs.o; \
	$$(AR_wasi) rcs $$(BUILD_DIR)/$(1)/wasi/libtlwasistubs.a $$(BUILD_DIR)/$(1)/wasi/stubs.o; \
	$$(RANLIB_wasi) $$(BUILD_DIR)/$(1)/wasi/libtlwasistubs.a; \
	echo "==> [wasi] $(1) — configure"; \
	mkdir -p $$(BUILD_DIR)/$(1)/wasi/Work; \
	HELPER_PATH="$$(NATIVE_BUILD)/Work/texk/web2c:$$(NATIVE_BUILD)/Work/texk/web2c/web2c"; \
	cd $$(BUILD_DIR)/$(1)/wasi/Work && \
	  export PATH="$$$$HELPER_PATH:$$$$PATH" && \
	  $$(TL_SOURCE)/configure \
	    --host=wasm32-wasi --build=x86_64-pc-linux-gnu \
	    --disable-shared --disable-largefile --disable-all-pkgs \
	    --enable-web2c --enable-omfonts=no \
	    --disable-luajittex --disable-luajithbtex \
	    --disable-aleph --disable-xetex \
	    --enable-pdftex \
	    --without-x --without-iconv \
	    CC="$$(CC_wasi)" CXX="$$(CXX_wasi)" AR="$$(AR_wasi)" RANLIB="$$(RANLIB_wasi)" \
	    CFLAGS="$$(WASI_CFLAGS)" CXXFLAGS="$$(WASI_CFLAGS)" \
	    LDFLAGS="$$(WASI_LDFLAGS) -L$$(BUILD_DIR)/$(1)/wasi -ltlwasistubs" \
	    > configure.log 2>&1 \
	  || (echo "==> [wasi] $(1) — configure FAILED"; tail -30 configure.log; exit 1); \
	echo "==> [wasi] $(1) — trimming SUBDIRS (libs='$$(TL_LIBS_$(1))', texk='$$(TL_TEXK_$(1))')"; \
	sed -i 's|^MAKE_SUBDIRS = .*|MAKE_SUBDIRS = $$(TL_LIBS_$(1))|' \
	  $$(BUILD_DIR)/$(1)/wasi/Work/libs/Makefile; \
	sed -i 's|^MAKE_SUBDIRS = .*|MAKE_SUBDIRS = $$(TL_TEXK_$(1))|' \
	  $$(BUILD_DIR)/$(1)/wasi/Work/texk/Makefile; \
	echo "==> [wasi] $(1) — blanking unused web2c _DEPEND vars"; \
	for dep in $$(TL_ALL_DEPENDS); do \
	  case " $$(TL_KEEP_DEPENDS_$(1)) " in *" $$$$dep "*) continue ;; esac; \
	  sed -i "s|^$$$${dep}_DEPEND = .*|$$$${dep}_DEPEND =|" \
	    $$(BUILD_DIR)/$(1)/wasi/Work/texk/web2c/Makefile 2>/dev/null || true; \
	done; \
	echo "==> [wasi] $(1) — injecting stubs.o into engine LDADD lines"; \
	STUBS_A_ABS=$$(BUILD_DIR)/$(1)/wasi/libtlwasistubs.a; \
	sed -i "s|^$(1)_LDADD = .*$$$$|& $$$$STUBS_A_ABS|" \
	  $$(BUILD_DIR)/$(1)/wasi/Work/texk/web2c/Makefile 2>/dev/null || true; \
	sed -i "s|^pdftex_LDADD = .*$$$$|& $$$$STUBS_A_ABS|" \
	  $$(BUILD_DIR)/$(1)/wasi/Work/texk/web2c/Makefile 2>/dev/null || true; \
	echo "==> [wasi] $(1) — make (experimental; expect porting issues)"; \
	cd $$(BUILD_DIR)/$(1)/wasi/Work && \
	  export PATH="$$$$HELPER_PATH:$$$$PATH" && \
	  ( \
	    $$(MAKE) -j$$(shell nproc 2>/dev/null || echo 2) && \
	    $$(MAKE) -C texk/web2c -j$$(shell nproc 2>/dev/null || echo 2) pdftex \
	  ) > make.log 2>&1 \
	  || (echo "==> [wasi] $(1) — make FAILED. Tail:"; tail -40 make.log; \
	      echo "==> [wasi] $(1) — partial state; touching stub for downstream"; \
	      mkdir -p $$(BUILD_DIR)/$(1)/wasi; touch $$@; exit 1); \
	if [ -f $$(BUILD_DIR)/$(1)/wasi/Work/texk/web2c/pdftex ]; then \
	  cp $$(BUILD_DIR)/$(1)/wasi/Work/texk/web2c/pdftex $$@; \
	else \
	  echo "==> [wasi] $(1) — pdftex binary not found; touching stub"; touch $$@; \
	fi; \
	echo "==> [wasi] $(1) — DONE"; \
	ls -la $$@
endef

$(foreach e,$(ENGINES_V1),$(eval $(call ENGINE_TEMPLATE_wasi,$(e))))
