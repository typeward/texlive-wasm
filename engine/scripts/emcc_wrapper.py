#!/usr/bin/env python3
"""
emcc_wrapper.py — intercept emcc invocations that would build a TL "helper"
binary (tangle, ctangle, otangle, tangleboot, ctangleboot, tie, web2c,
fixwrites, makecpool, splitup, ...) and substitute a pre-built native binary.

This is the standard trick for TL cross-compile: TL's build invokes its own
helper binaries mid-build to translate Pascal-WEB sources to C, generate
look-up tables, etc. Those helpers can't be wasm (they need to run on the
host). We pre-build them natively, then this wrapper copies the native binary
into the place where emcc would have produced a wasm one.

Usage:
  emcc_wrapper.py <native-helper-paths...> -- <emcc-or-em++-and-args>

Behavior:
  - Splits argv on the first "--".
  - Left side: paths to pre-built native helper binaries.
  - Right side: the actual compiler invocation we'd otherwise pass through.
  - If the right side has `-o <out>` AND basename(out) matches basename(any
    helper), copy the native helper to <out> and exit 0.
  - Otherwise exec the right side verbatim and exit with its status.

Adapted from busytex's emcc_wrapper.py (MIT). Rewritten for clarity.
"""

from __future__ import annotations
import os
import shutil
import subprocess
import sys


def main() -> int:
    argv = sys.argv[1:]
    try:
        sep = argv.index("--")
    except ValueError:
        print("emcc_wrapper.py: missing '--' separator", file=sys.stderr)
        return 2

    helpers = argv[:sep]
    cmd = argv[sep + 1 :]

    out_target = _find_o_target(cmd)
    if out_target is not None:
        out_basename = os.path.basename(out_target)
        for helper in helpers:
            if os.path.basename(helper) == out_basename:
                _copy_helper(helper, out_target)
                return 0

    # Not a helper output — actually run the compile.
    return subprocess.call(cmd)


def _find_o_target(cmd: list[str]) -> str | None:
    """Return the value of the last `-o <path>` arg, or None."""
    target: str | None = None
    for i, arg in enumerate(cmd[:-1]):
        if arg == "-o":
            target = cmd[i + 1]
    return target


def _copy_helper(src: str, dst: str) -> None:
    dirname = os.path.dirname(dst)
    if dirname:
        os.makedirs(dirname, exist_ok=True)
    shutil.copy2(src, dst)


if __name__ == "__main__":
    sys.exit(main())
