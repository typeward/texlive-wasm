# Shared variables and helpers used by both emscripten.mk and wasi.mk.

# Optimization level. Override on the command line for debug builds:
#   make pdflatex-emscripten OPT=-O0
OPT ?= -Oz

# WebAssembly threading. Adds atomics + bulk-memory opcodes to the compiled
# wasm so libs (libharfbuzz, ICU, lua* runtimes) can call pthread primitives
# instead of degrading to no-ops. Requires the host page to be cross-origin
# isolated (COOP=same-origin + COEP=require-corp) so SharedArrayBuffer is
# available. Disable for the legacy single-thread build with
# `make ... ENABLE_THREADS=0`.
ENABLE_THREADS ?= 1
ifeq ($(ENABLE_THREADS),1)
THREAD_CFLAGS  := -pthread -mbulk-memory -matomics
THREAD_LDFLAGS := -pthread -sSHARED_MEMORY=1
else
THREAD_CFLAGS  :=
THREAD_LDFLAGS :=
endif

# Reproducible builds.
export SOURCE_DATE_EPOCH ?= 1700000000

# Mobile-strip patterns live in engine/configs/mobile-strip.list (the single
# source of truth, consumed by scripts/build-manifest.ts --full-strip).

# Format files we ship pre-built.
FMT_pdflatex  := latex.fmt
FMT_xelatex   := xelatex.fmt
FMT_lualatex  := lualatex.fmt

# Path to the TL source (also exported in emscripten.mk; defined here so
# native.mk and icu-native.mk can reference it without ordering dependency).
TL_SOURCE := $(SOURCE_DIR)/texlive-source
