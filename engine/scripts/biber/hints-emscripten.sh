# Perl hints file for the wasm32-emscripten cross build (biber.wasm spike).
#
# Adapted from zeroperl's hints-wasi.sh (github.com/uswriting/zeroperl, MIT)
# — the settings map for Perl 5.42 on wasm32 — with the WASI-specific parts
# replaced by Emscripten equivalents: Emscripten's libc provides signals,
# getpid, clocks and native setjmp/longjmp (-sSUPPORT_LONGJMP), so none of
# the wasi-emulated libraries or the custom asyncjmp runtime are needed.
#
# Placeholders substituted by spike-build.sh:
#   __PERLCC__      compiler wrapper (engine/scripts/biber/perlcc)
#   __NATIVE_DIR__  native perl build dir (miniperl, generate_uudmap)

osname='emscripten'
archname='wasm32-emscripten'
myuname='texlive-wasm biber spike'
myhostname='localhost'

cc='__PERLCC__'
ld='__PERLCC__'
optimize='-O2'

hostperl='__NATIVE_DIR__/miniperl'
hostgenerate='__NATIVE_DIR__/generate_uudmap'

prefix='/perl'
inc_version_list='none'
man1dir='none'
man3dir='none'

# Static everything — no dynamic loading in our wasm runtime.
dlsrc='none'
usedl='undef'
d_dlopen='undef'
loclibpth=''
glibpth=''

# Process control / IPC that Emscripten cannot provide for real.
d_fork='undef'
d_vfork='undef'
d_wait='undef'
d_waitpid='undef'
d_syscall='undef'
d_pause='undef'
d_killpg='undef'
d_msgctl='undef'
d_msgget='undef'
d_msgrcv='undef'
d_msgsnd='undef'
d_semctl='undef'
d_semget='undef'
d_semop='undef'
d_shmat='undef'
d_shmctl='undef'
d_shmdt='undef'
d_shmget='undef'

# User/group management is a stub world under Emscripten.
d_getpwnam='undef'
d_getpwuid='undef'
d_getgrnam='undef'
d_getgrgid='undef'
d_setrgid='undef'
d_setruid='undef'

# Single-threaded interpreter.
usethreads='undef'
usemultiplicity='undef'
useithreads='undef'
i_pthread='undef'
d_pthread_atfork='undef'
usemymalloc='n'
usenm='undef'

# wasm32 type layout (identical to zeroperl's — same ABI).
charsize='1'
shortsize='2'
intsize='4'
longsize='4'
longlongsize='8'
doublesize='8'
ptrsize='4'
alignbytes='8'
use64bitint='define'
use64bitall='undef'
ivtype='long long'
uvtype='unsigned long long'
ivsize='8'
uvsize='8'
quadtype='long long'
uquadtype='unsigned long long'
d_quad='define'
nvtype='double'
nvsize='8'
usequadmath='undef'
uselongdouble='undef'

uselargefiles='define'
lseektype='off_t'
lseeksize='8'

# Locale: Emscripten ships the plain "C" locale only.
d_setlocale='undef'
d_perl_lc_all_separator='define'
perl_lc_all_separator=';'
d_perl_lc_all_category_positions_init='define'
perl_lc_all_category_positions_init='{ 0, 1, 2, 3, 4, 5 }'

ccflags='-DBIG_TIME -DNO_MATHOMS -DPERL_USE_SAFE_PUTENV -fno-strict-aliasing -Wno-int-conversion -Wno-implicit-function-declaration'
ldflags=''
libs='-lm'

# With usedl=undef every buildable extension is compiled INTO libperl —
# maximally biber-friendly, so only exclude what cannot work. POSIX and
# Encode are deliberately kept (biber's dep tree leans on both); Emscripten's
# libc is complete enough. Grow this list only when something actually
# fails to compile.
noextensions='threads threads/shared IPC/SysV GDBM_File NDBM_File ODBM_File DB_File'
