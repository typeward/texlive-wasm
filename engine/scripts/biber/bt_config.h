/*
 * bt_config.h — static replacement for btparse's autoconf-generated config
 * (Text-BibTeX bundles btparse; its Build.PL generates this via
 * Config::AutoConf, which cannot run against a wasm toolchain). Answers are
 * for Emscripten's musl libc.
 */
#ifndef BT_CONFIG_H
#define BT_CONFIG_H

#define HAVE_ALLOCA 1
#define HAVE_ALLOCA_H 1
#define HAVE_STRDUP 1
#define HAVE_STRDUP_DECL 1
#define HAVE_VPRINTF 1
#define HAVE_VSNPRINTF 1
#define STDC_HEADERS 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_STDINT_H 1
#define HAVE_LIMITS_H 1
#define HAVE_UNISTD_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
/* musl declares strlcat in string.h — without this, btparse's static
 * fallback collides with the libc declaration. */
#define HAVE_STRLCAT 1
/* musl has no strlwr/strupr; btparse carries fallbacks. */

#define PACKAGE "btparse"
#define PACKAGE_NAME "btparse"
#define PACKAGE_STRING "btparse (texlive-wasm static build)"
#define PACKAGE_VERSION "0.91"
#define VERSION "0.91"

#endif
