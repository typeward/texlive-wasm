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

# Mobile-strip: include files exclude any TDS path matching these prefixes
# when assembling the npm artifact bundles. (The engine binaries themselves
# don't reference them; this is the bundle-size optimization.)
MOBILE_STRIP_PREFIXES := \
	doc/ \
	source/ \
	tex/latex/babel-* \
	tex/generic/babel-* \
	fonts/source/ \
	scripts/

# Format files we ship pre-built.
FMT_pdflatex  := latex.fmt
FMT_xelatex   := xelatex.fmt
FMT_lualatex  := lualatex.fmt

# Path to the TL source (also exported in emscripten.mk; defined here so
# native.mk and icu-native.mk can reference it without ordering dependency).
TL_SOURCE := $(SOURCE_DIR)/texlive-source
