/* sys/wait.h shim for wasi-sdk (WASI has no fork/wait) — declarations so
 * kpathsea/tex-make.c compiles. Runtime calls into the stubs in stubs.c
 * which all return -1 / EAGAIN, so the fork() guard in tex-make.c bails
 * out gracefully with fn=NULL (no on-demand mktex, which we don't ship
 * anyway in WASM). */
#ifndef _WASI_SHIM_SYS_WAIT_H
#define _WASI_SHIM_SYS_WAIT_H

#include <sys/types.h>

#define WNOHANG    1
#define WUNTRACED  2

#define WEXITSTATUS(s) (((s) >> 8) & 0xff)
#define WTERMSIG(s)    ((s) & 0x7f)
#define WSTOPSIG(s)    WEXITSTATUS(s)
#define WIFEXITED(s)   (WTERMSIG(s) == 0)
#define WIFSIGNALED(s) (((s) & 0xffff) - 1u < 0xffu)
#define WIFSTOPPED(s)  ((short)((((s) & 0xffff) * 0x10001) >> 8) > 0x7f00)
#define WCOREDUMP(s)   ((s) & 0x80)

#ifdef __cplusplus
extern "C" {
#endif
pid_t wait(int *);
pid_t waitpid(pid_t, int *, int);
#ifdef __cplusplus
}
#endif

#endif
