/*
 * Force-included into every TL compilation unit to provide stubs for libc
 * functions Emscripten's libc doesn't have.
 *
 * Static inline keeps each translation unit's copy local — no link-time
 * symbol clash, no libtool/library-build complications.
 */

#ifndef TLWASM_STUBS_FORCE_H
#define TLWASM_STUBS_FORCE_H

#ifdef __EMSCRIPTEN__

#include <stddef.h>
#include <sys/types.h>

#ifndef TLWASM_HAS_GETPASS
#define TLWASM_HAS_GETPASS 1
static inline char *getpass(const char *prompt) {
    (void)prompt;
    return (char *)0;
}
#endif

/* zziplib (pulled in by luatex's luazip module) references off64_t, which
   Emscripten's libc doesn't define (it only has off_t). They're the same
   type in our build, so just alias. */
#ifndef TLWASM_HAS_OFF64_T
#define TLWASM_HAS_OFF64_T 1
typedef off_t off64_t;
#endif

#endif /* __EMSCRIPTEN__ */

#endif /* TLWASM_STUBS_FORCE_H */
