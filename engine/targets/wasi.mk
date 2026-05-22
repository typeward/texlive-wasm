# WASI target — the Node / Wasmtime / edge build path.
#
# wasi-sdk gives us a single statically-linked .wasm per engine. No .js,
# no FS adapter — Wasmtime mounts host directories via WASI preopens.

CC_wasi   := $(WASI_SDK_PATH)/bin/clang
CXX_wasi  := $(WASI_SDK_PATH)/bin/clang++
AR_wasi   := $(WASI_SDK_PATH)/bin/llvm-ar
RANLIB_wasi := $(WASI_SDK_PATH)/bin/llvm-ranlib

WASI_SYSROOT := $(WASI_SDK_PATH)/share/wasi-sysroot

WASI_COMMON := \
	$(OPT) \
	--target=wasm32-wasi-threads \
	--sysroot=$(WASI_SYSROOT) \
	-D_WASI_EMULATED_SIGNAL \
	-D_WASI_EMULATED_PROCESS_CLOCKS \
	-D_WASI_EMULATED_GETPID \
	-D_WASI_EMULATED_MMAN

WASI_LDFLAGS := \
	-lwasi-emulated-signal \
	-lwasi-emulated-process-clocks \
	-lwasi-emulated-getpid \
	-lwasi-emulated-mman \
	-Wl,--export-memory \
	-Wl,--initial-memory=67108864 \
	-Wl,--max-memory=2147483648

define ENGINE_TEMPLATE_wasi
.PHONY: $(1)-wasi
$(1)-wasi: source
	@echo "==> [wasi] $(1) — TODO: wire up the link recipe (Phase 1)"
	@mkdir -p $$(BUILD_DIR)/$(1)/wasi
	@touch $$(BUILD_DIR)/$(1)/wasi/$(1).wasm
endef

$(foreach e,$(ENGINES_V1),$(eval $(call ENGINE_TEMPLATE_wasi,$(e))))
