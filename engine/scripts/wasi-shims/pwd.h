/* pwd.h shim for wasi-sdk — WASI has no user database. Provides struct
 * passwd and getpw* declarations so xpdf's goo/gfile.cc compiles. Runtime
 * calls return NULL via stubs.c (path expansion of '~user' falls back to
 * leaving the literal in place, which is fine since we don't run as a
 * traditional user under WASI). */
#ifndef _WASI_SHIM_PWD_H
#define _WASI_SHIM_PWD_H

#include <sys/types.h>

struct passwd {
    char  *pw_name;
    char  *pw_passwd;
    uid_t  pw_uid;
    gid_t  pw_gid;
    char  *pw_gecos;
    char  *pw_dir;
    char  *pw_shell;
};

#ifdef __cplusplus
extern "C" {
#endif
struct passwd *getpwnam(const char *);
struct passwd *getpwuid(uid_t);
#ifdef __cplusplus
}
#endif

#endif
