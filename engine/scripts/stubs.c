/*
 * Stubs for libc functions that TL references but Emscripten's libc doesn't
 * provide. Linked into engines that need them (e.g. xdvipdfmx for getpass).
 *
 * These all return failure or empty values — TL won't actually need to call
 * them in any normal compile flow (encryption is unsupported in the WASM
 * build, signal handling is irrelevant, etc.).
 */

#include <stddef.h>
#include <stdio.h>

/* xdvipdfmx uses getpass() for PDF encryption password prompts. We don't
   support encryption in the WASM build, so always return NULL. */
char *getpass(const char *prompt) {
    (void)prompt;
    fprintf(stderr, "getpass: not supported in the WASM build\n");
    return NULL;
}
