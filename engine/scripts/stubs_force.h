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

#ifdef __wasi__
#include <sys/types.h>
#include <stdio.h>
#include <unistd.h>
#include <pwd.h>
#ifndef TLWASM_WASI_FORCE
#define TLWASM_WASI_FORCE 1
#ifdef __cplusplus
extern "C" {
#endif
uid_t getuid(void);
uid_t geteuid(void);
gid_t getgid(void);
gid_t getegid(void);
char *getpass(const char *);
typedef off_t off64_t;

void  flockfile(FILE *);
int   ftrylockfile(FILE *);
void  funlockfile(FILE *);
FILE *popen(const char *, const char *);
int   pclose(FILE *);
int   system(const char *);
struct passwd *getpwnam(const char *);
struct passwd *getpwuid(uid_t);
pid_t fork(void);
pid_t vfork(void);
pid_t wait(int *);
pid_t waitpid(pid_t, int *, int);
int   execvp(const char *, char *const[]);
int   execv(const char *, char *const[]);
int   execve(const char *, char *const[], char *const[]);
int   pipe(int[2]);
int   dup(int);
int   dup2(int, int);
int   kill(pid_t, int);
#ifdef __cplusplus
}
#endif
#endif
#endif /* __wasi__ */

#endif /* TLWASM_STUBS_FORCE_H */
