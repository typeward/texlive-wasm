import { BaseEngineWrapper } from './base';
import type { EngineId, FileInput, RunResult } from '../core/types';

export interface BiberOptions {
  /** Jobname — the `.bcf` basename, with or without the extension. */
  jobname: string;
  /** Project files; must include `<jobname>.bcf` and the `.bib` sources. */
  files?: FileInput[];
  /** Extra biber arguments (e.g. `--isbn-normalise`). */
  extraArgs?: string[];
}

/**
 * biber — the biblatex backend, i.e. Perl 5.42 + biber 2.19 compiled to
 * wasm. The engine artifact is `biber.wasm` and its VFS is
 * `biber-vfs.tar.gz` (pass it as `EngineConfig.bundleUrl`); the VFS is
 * mounted at the filesystem ROOT (/perl, /biber), not under /texmf-dist.
 *
 * The wasm main() is the Perl interpreter: argv runs the bundled biber
 * script from the VFS. `--noconf` skips config-file discovery (there is no
 * home directory worth searching), and biber reads `<jobname>.bcf` from
 * the working directory, writing `<jobname>.bbl`/`.blg` beside it.
 *
 * The shipped biber version is LOCKSTEPPED to the TDS biblatex version
 * (biblatex validates the .bbl format version and biber validates the
 * .bcf version — a mismatched pair refuses to run).
 */
export class Biber extends BaseEngineWrapper {
  protected readonly engineId: EngineId = 'biber';

  async run(options: BiberOptions): Promise<RunResult> {
    const jobname = options.jobname.replace(/\.bcf$/i, '');
    const args = ['/biber/bin/biber', '--noconf', ...(options.extraArgs ?? []), jobname];
    return this.runRaw(args, options.files ?? []);
  }
}
