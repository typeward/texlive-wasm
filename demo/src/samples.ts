/**
 * Sample projects for the showcase. Sources are lifted from the repo's smoke
 * tests (scripts/smoke-*.mjs) so the site demonstrates exactly what CI proves.
 */

import type { LatexmkEngine } from 'texlive-wasm';

export interface SampleFile {
  path: string;
  content: string;
}

export interface Sample {
  id: string;
  title: string;
  blurb: string;
  engine: LatexmkEngine;
  mainTex: string;
  files: SampleFile[];
}

export const HELLO: Sample = {
  id: 'hello',
  title: 'Hello, amsmath',
  blurb: 'The classic: an equation typeset by pdfTeX, entirely in your browser.',
  engine: 'pdflatex',
  mainTex: 'main.tex',
  files: [
    {
      path: 'main.tex',
      content: `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
Hello from \\TeX{}Live 2026 on WebAssembly!

\\begin{equation}
  E = mc^2
\\end{equation}
\\end{document}
`,
    },
  ],
};

export const EXTRAS: Sample = {
  id: 'extras',
  title: 'TikZ + siunitx + algorithm2e',
  blurb: 'Vector graphics, SI units and pseudocode — the packages people actually use.',
  engine: 'pdflatex',
  mainTex: 'main.tex',
  files: [
    {
      path: 'main.tex',
      content: `\\documentclass{article}
\\usepackage{siunitx}
\\usepackage{tikz}
\\usepackage[ruled]{algorithm2e}
\\usepackage{xcolor}
\\begin{document}
\\section{Units}
The speed of light is \\SI{2.998e8}{\\meter\\per\\second}.

\\section{Graphics}
\\begin{tikzpicture}
  \\draw[red, thick] (0,0) circle (1cm);
  \\filldraw[blue] (0,0) circle (2pt);
  \\draw[->, thick] (0,0) -- (0.95,0) node[midway, above] {$r$};
\\end{tikzpicture}

\\section{Algorithms}
\\begin{algorithm}[H]
  \\KwData{numbers $a, b$}
  \\KwResult{$\\gcd(a, b)$}
  \\While{$b \\neq 0$}{
    $r \\leftarrow a \\bmod b$\\;
    $a \\leftarrow b$\\;
    $b \\leftarrow r$\\;
  }
  \\Return $a$\\;
  \\caption{Euclid's algorithm}
\\end{algorithm}
\\end{document}
`,
    },
  ],
};

export const BIBLIOGRAPHY: Sample = {
  id: 'bibliography',
  title: 'Bibliography (BibTeXu)',
  blurb:
    'latexmk auto-detects \\bibliography{}, runs Unicode BibTeX in its own worker, and reruns pdfTeX until citations resolve.',
  engine: 'pdflatex',
  mainTex: 'main.tex',
  files: [
    {
      path: 'main.tex',
      content: `\\documentclass{article}
\\begin{document}
Knuth's magnum opus~\\cite{KnuthArt} needs no introduction.

\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`,
    },
    {
      path: 'refs.bib',
      content: `@book{KnuthArt,
  author    = {Donald E. Knuth},
  title     = {The Art of Computer Programming},
  publisher = {Addison-Wesley},
  year      = {1968},
}
`,
    },
  ],
};

export const INDEX: Sample = {
  id: 'index',
  title: 'Index (makeindex)',
  blurb:
    'latexmk collects \\index{} entries, runs makeindex in its own worker, and folds the result back in.',
  engine: 'pdflatex',
  mainTex: 'main.tex',
  files: [
    {
      path: 'main.tex',
      content: `\\documentclass{article}
\\usepackage{makeidx}
\\makeindex
\\begin{document}
\\section{Terms}
An algorithm\\index{algorithm} is a finite procedure.
Recursion\\index{recursion} is when a thing is defined in terms of itself.
A binary tree\\index{binary tree} has at most two children per node.
More on algorithms\\index{algorithm} and recursion\\index{recursion} later.

\\printindex
\\end{document}
`,
    },
  ],
};

export const RERUN: Sample = {
  id: 'rerun',
  title: 'Multi-pass (TOC + cross-references)',
  blurb:
    'A table of contents and a forward reference force multiple passes — watch the pass counter.',
  engine: 'pdflatex',
  mainTex: 'main.tex',
  files: [
    {
      path: 'main.tex',
      content: `\\documentclass{article}
\\begin{document}
\\tableofcontents

\\section{First things}\\label{sec:first}
As we will see in Section~\\ref{sec:last}, everything connects.

\\section{Last things}\\label{sec:last}
This refers back to Section~\\ref{sec:first} — resolved on the second pass.
\\end{document}
`,
    },
  ],
};

export const XELATEX: Sample = {
  id: 'xelatex',
  title: 'XeLaTeX + Unicode',
  blurb:
    'XeTeX cannot spawn xdvipdfmx in WASM (no processes!), so latexmk holds the .xdv and finalizes it in a second worker.',
  engine: 'xelatex',
  mainTex: 'main.tex',
  files: [
    {
      path: 'main.tex',
      content: `\\documentclass{article}
\\begin{document}
\\section{XeTeX in WebAssembly}
The quick brown fox jumps over the lazy dog.

Typeset by XeTeX (ICU 78.2) and converted to PDF by a separate
xdvipdfmx engine instance — two WASM workers cooperating.
\\end{document}
`,
    },
  ],
};

export const LUALATEX: Sample = {
  id: 'lualatex',
  title: 'LuaLaTeX + \\directlua',
  blurb: 'LuaHBTeX 1.24.0 — a whole Lua interpreter runs inside the engine.',
  engine: 'lualatex',
  mainTex: 'main.tex',
  files: [
    {
      path: 'main.tex',
      content: `\\documentclass{article}
\\begin{document}
\\section{Lua inside \\TeX{}}
$2^{10} = \\directlua{tex.sprint(2^10)}$, says the embedded Lua interpreter.

The answer to everything is \\directlua{tex.sprint(6 * 7)}.
\\end{document}
`,
    },
  ],
};

export const SYNCTEX: Sample = {
  id: 'synctex',
  title: 'SyncTeX (two-file project)',
  blurb: 'Compile with -synctex=1 and parse the .synctex.gz output in JS.',
  engine: 'pdflatex',
  mainTex: 'main.tex',
  files: [
    {
      path: 'main.tex',
      content: `\\documentclass{article}
\\begin{document}
\\section{Main file}
This project has two source files.

\\input{section1}
\\end{document}
`,
    },
    {
      path: 'section1.tex',
      content: `\\section{Included file}
This text lives in section1.tex — SyncTeX records both inputs.
`,
    },
  ],
};

export const ALL_SAMPLES: Sample[] = [
  HELLO,
  EXTRAS,
  BIBLIOGRAPHY,
  INDEX,
  RERUN,
  XELATEX,
  LUALATEX,
  SYNCTEX,
];
