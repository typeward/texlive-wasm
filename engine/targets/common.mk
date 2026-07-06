# Shared variables and helpers used by both emscripten.mk and wasi.mk.

# Optimization level. Override on the command line for debug builds:
#   make pdflatex-emscripten OPT=-O0
OPT ?= -Oz

# WebAssembly threading. OFF by default: nothing in the engines spawns
# threads (TeX is single-threaded; library pthread primitives degrade to
# safe no-ops), and a threaded build allocates SharedArrayBuffer-backed
# memory, which hard-requires a cross-origin-isolated page — something
# Android System WebView (our primary Tauri target) cannot reliably
# provide. Opt back in with `make ... ENABLE_THREADS=1`; that build only
# runs where COOP=same-origin + COEP=require-corp headers are served.
ENABLE_THREADS ?= 0
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
