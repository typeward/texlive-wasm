import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const m = await import("./engine-artifacts/pdflatex/emscripten/pdflatex.js");

function walk(FS, absDir, mfsDir) {
  if (!FS.analyzePath(mfsDir).exists) FS.mkdir(mfsDir);
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name);
    const mfs = mfsDir + "/" + name;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(FS, abs, mfs);
    else if (st.isFile()) { try { FS.writeFile(mfs, readFileSync(abs)); } catch {} }
  }
}

const Module = await m.default({
  noInitialRun: true,
  thisProgram: "/bin/pdflatex",
  print: (t) => console.log(t),
  printErr: (t) => console.error("E:", t),
});

walk(Module.FS, "./engine-artifacts/texmf", "/texmf-dist");
Module.FS.mkdir("/bin");
Module.FS.writeFile("/bin/pdflatex", new Uint8Array());
Module.FS.mkdir("/project");
Module.FS.chdir("/project");
Module.FS.writeFile("/project/hello.tex",
  "\\documentclass{article}\\begin{document}Hello\\end{document}\n");

const T = "/texmf-dist";

let exitCode;
try {
  exitCode = Module.callMain([
    "-interaction=nonstopmode",
    "-fmt=" + T + "/web2c/pdftex/pdflatex.fmt",
    "-cnf-line=TEXMFCNF=" + T + "/web2c",
    "-cnf-line=TEXMF=" + T,
    "-cnf-line=TEXMFDIST=" + T,
    "-cnf-line=TEXINPUTS=.;" + T + "/tex//",
    "-cnf-line=TFMFONTS=.;" + T + "/fonts/tfm//",
    "-cnf-line=VFFONTS=.;" + T + "/fonts/vf//",
    "hello.tex",
  ]);
} catch (e) { exitCode = e?.status ?? -1; }

console.log("EXIT:", exitCode);

if (Module.FS.analyzePath("/project/hello.pdf").exists) {
  const pdf = Module.FS.readFile("/project/hello.pdf");
  writeFileSync("hello-from-wasm.pdf", pdf);
  console.log("PDF:", pdf.length, "bytes");
} else if (Module.FS.analyzePath("/project/hello.log").exists) {
  const log = new TextDecoder().decode(Module.FS.readFile("/project/hello.log"));
  // Look for first error
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/error|Error|Warning|! /.test(lines[i])) {
      console.log("--- log around error line", i, "---");
      console.log(lines.slice(Math.max(0, i-3), Math.min(lines.length, i+15)).join("\n"));
      break;
    }
  }
}
