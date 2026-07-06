#!/usr/bin/env node
/**
 * check-biber-lockstep.mjs — biblatex validates the .bbl format version and
 * biber validates the .bcf version; a mismatched pair refuses to run
 * (observed live: Debian's biber 2.18 rejects biblatex-3.19 control files
 * with an empty .bbl). This asserts the TDS biblatex version pairs with the
 * biber version pinned in the wasm build.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Upstream pairing table (biblatex ↔ required biber).
const PAIRS = {
  '3.19': '2.19',
  '3.20': '2.20',
  '3.21': '2.21',
};

const sty = join(ROOT, 'engine-artifacts/texmf/tex/latex/biblatex/biblatex.sty');
if (!existsSync(sty)) {
  console.error(`lockstep: ${sty} not found — run scripts/fetch-tds.sh first`);
  process.exit(1);
}
const styText = readFileSync(sty, 'utf8');
// biblatex.sty declares its version as: \def\abx@version{3.19}
const biblatex = styText.match(/\\def\\abx@version\{(\d+\.\d+)\}/)?.[1];
if (!biblatex) {
  console.error('lockstep: could not parse the biblatex version from biblatex.sty');
  process.exit(1);
}

const spike = readFileSync(join(ROOT, 'engine/scripts/biber/spike-build.sh'), 'utf8');
const biber = spike.match(/^BIBER_VERSION=(\S+)/m)?.[1];
if (!biber) {
  console.error('lockstep: could not parse BIBER_VERSION from spike-build.sh');
  process.exit(1);
}

const wanted = PAIRS[biblatex];
if (!wanted) {
  console.error(
    `lockstep: unknown biblatex ${biblatex} — extend the pairing table in this script`,
  );
  process.exit(1);
}
if (wanted !== biber) {
  console.error(
    `lockstep MISMATCH: TDS ships biblatex ${biblatex} (needs biber ${wanted}) ` +
      `but the wasm build pins biber ${biber}. Fix one side before shipping.`,
  );
  process.exit(1);
}
console.log(`lockstep OK: biblatex ${biblatex} ↔ biber ${biber}`);
