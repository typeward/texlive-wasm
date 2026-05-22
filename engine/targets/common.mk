# Shared variables and helpers used by both emscripten.mk and wasi.mk.

# Optimization level. Override on the command line for debug builds:
#   make pdflatex-emscripten OPT=-O0
OPT ?= -Oz

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
