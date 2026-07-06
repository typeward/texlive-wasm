/*
 * emstubs.c — platform stubs for the fork-less Emscripten Perl build.
 *
 * With d_fork undefined, pp_sys.c routes system()/exec through the
 * platform's do_spawn/do_aspawn (the Win32/RISC OS model). There are no
 * processes in our wasm runtime, so both fail cleanly with ENOSYS —
 * callers see system() == -1 with a sensible errno instead of a link
 * error or an abort. (Biber never needs to spawn; IPC::Cmd/IPC::Run3
 * paths that try get a proper failure.)
 */
#include <errno.h>
#include <signal.h>
#include <sys/time.h>

int do_spawn(char *cmd);
int do_aspawn(void *vreally, void **vmark, void **vsp);

/*
 * libc gaps in Emscripten's musl subset. POSIX.xs calls sigsuspend
 * unconditionally (POSIX mandates it), and doio.c references futimes
 * whenever Configure saw one — neither can exist without signals or
 * file-timestamp syscalls, so both fail with ENOSYS.
 */
int
sigsuspend(const sigset_t *mask)
{
    (void)mask;
    errno = ENOSYS;
    return -1;
}

int
futimes(int fd, const struct timeval tv[2])
{
    (void)fd;
    (void)tv;
    errno = ENOSYS;
    return -1;
}

int
do_spawn(char *cmd)
{
    (void)cmd;
    errno = ENOSYS;
    return -1;
}

int
do_aspawn(void *vreally, void **vmark, void **vsp)
{
    (void)vreally;
    (void)vmark;
    (void)vsp;
    errno = ENOSYS;
    return -1;
}
