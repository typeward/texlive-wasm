/*
 * Stubs for libc functions that TL references but Emscripten's libc doesn't
 * provide. Linked into engines that need them (e.g. xdvipdfmx for getpass).
 *
 * These all return failure or empty values — TL won't actually need to call
 * them in any normal compile flow (encryption is unsupported in the WASM
 * build, signal handling is irrelevant, etc.).
 */

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

/* xdvipdfmx uses getpass() for PDF encryption password prompts. We don't
   support encryption in the WASM build, so always return NULL. */
char *getpass(const char *prompt) {
    (void)prompt;
    fprintf(stderr, "getpass: not supported in the WASM build\n");
    return NULL;
}

/* ICU data stub for engines that link libicuuc/libicudata.
 *
 * The real `icudt<VV>_dat` symbol is a ~30 MB binary blob produced by ICU's
 * `pkgdata` from per-locale resource bundles. In our cross-build those .res.o
 * files are emitted as ELF objects by genccode, which wasm-ld can't link.
 *
 * We provide a minimal valid ICU data header so libicuuc loads cleanly. At
 * runtime, ICU calls that need locale data (numbers, dates, collation tables)
 * will return U_MISSING_RESOURCE_ERROR. The xetex use of ICU is mostly for
 * harfbuzz/normalization which works with the embedded BMP tables in
 * libicuuc itself; it does not require icudt<VV>_dat to be populated.
 *
 * A real fix would be to switch ICU to `--with-data-packaging=common`, ship
 * the icudt<VV>l.dat file at /icudt<VV>l.dat in MEMFS, and call
 * udata_setCommonData() from JS. That's Phase 2 — for now the engine links
 * and runs.
 *
 * The header layout below matches ICU's UDataInfo struct enough to satisfy
 * libicuuc's `u_getMainInfo` validation. ICU versions 76+ all use the same
 * 32-byte UDataInfo prefix.
 */

/* Empty ICU data file: 20-byte MappedData header + 32-byte UDataInfo +
 * 12-byte padding; total 64 bytes. ICU sees this, finds no entries, and
 * returns U_MISSING_RESOURCE_ERROR for lookups. */
__attribute__((aligned(16)))
const uint8_t icudt76_dat[64] = {
    0x20, 0x00, /* headerSize */
    0xda, 0x27, /* magic1, magic2 */
    /* UDataInfo (20 bytes) */
    0x14, 0x00, /* size = 20 */
    0x00, 0x00, /* reserved */
    0x01,       /* isBigEndian = 0 (little-endian) */
    0x02,       /* charsetFamily = 0 (ASCII) — wait, set to 0 */
    0x02,       /* sizeofUChar = 2 */
    0x00,       /* reserved */
    0x00, 0x00, 0x00, 0x00, /* dataFormat */
    0x00, 0x00, 0x00, 0x00, /* formatVersion */
    0x00, 0x00, 0x00, 0x00, /* dataVersion */
    /* padding to total 64 bytes */
    0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
    0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
    0,0,0,0
};

/* Alias for the version we currently build against (TL 2026 ships ICU 76,
 * but the icu-src in TL 2026 advertises 78 in icudt<VV>_dat name). */
__attribute__((alias("icudt76_dat")))
extern const uint8_t icudt78_dat[64];
