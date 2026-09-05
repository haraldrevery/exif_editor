#!/usr/bin/env python3
"""Compile the Rust core for Windows, from a Linux or macOS checkout.

Why this is not just ``cargo check --target x86_64-pc-windows-msvc``: that runs
``tauri-build``, which reaches for ``llvm-rc`` to embed the app icon into the
executable's resources and panics with ``NotAttempted("llvm-rc")`` when it is
not installed. That is a *packaging* step. It has nothing to say about whether
the code compiles, and it stops the one check that does.

So the core modules are compiled on their own, through a throwaway crate that
``#[path]``-includes them and depends on nothing from Tauri. What that covers
is exactly the code no Linux build ever looks at:

  * ``write::check_parent_writable`` — the ``#[cfg(not(unix))]`` branch, which
    exists because Windows' read-only *directory* attribute means "customised",
    not "unwritable", and trusting it refuses to save into Pictures, Documents
    and Desktop.
  * ``write::sync_parent_dir`` — a no-op there, since NTFS journals the rename.
  * ``exiftool::spawn``'s ``CREATE_NO_WINDOW``, which keeps a console window
    from appearing for the life of the app.

None of it is reachable from a Linux ``cargo test``, so without this the first
time anyone finds out is a Windows build.

Usage:
    python3 build_tools/check_windows.py            # msvc (default)
    python3 build_tools/check_windows.py --target x86_64-pc-windows-gnu

Requires the target's standard library:
    rustup target add x86_64-pc-windows-msvc
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / "tauri" / "src"

# The modules `tauri/src/lib.rs` declares. Kept in step with it by the check
# below rather than by hope.
MODULES = ["catalogue", "exiftool", "gpx", "library", "thumbcache", "undo", "write"]

CARGO_TOML = """[package]
name = "revery-exif-wincheck"
version = "0.0.0"
edition = "2021"

[lib]
path = "src/lib.rs"

[dependencies]
serde      = { version = "1", features = ["derive"] }
serde_json = "1"
sha2       = "0.10"
base64     = "0.22"
roxmltree  = "0.20"
dunce      = "1.0"

[workspace]
"""


def declared_modules() -> list[str]:
    """The modules lib.rs actually declares, so this file cannot drift from it."""
    text = (CORE / "lib.rs").read_text(encoding="utf-8")
    found = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("pub mod ") and line.endswith(";"):
            found.append(line[len("pub mod ") : -1].strip())
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default="x86_64-pc-windows-msvc")
    args = parser.parse_args()

    actual = declared_modules()
    if sorted(actual) != sorted(MODULES):
        print(
            f"MODULES in this script is out of step with tauri/src/lib.rs.\n"
            f"  lib.rs declares: {sorted(actual)}\n"
            f"  this script has: {sorted(MODULES)}\n"
            f"Update MODULES so the cross-check keeps covering everything.",
            file=sys.stderr,
        )
        return 2

    if shutil.which("cargo") is None:
        print("cargo is not on PATH", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory() as tmp:
        crate = Path(tmp) / "wincheck"
        (crate / "src").mkdir(parents=True)
        (crate / "Cargo.toml").write_text(CARGO_TOML, encoding="utf-8")
        # Absolute paths, so the throwaway crate compiles the real sources
        # rather than a copy that could go stale mid-run.
        lib = "\n".join(
            f'#[path = "{CORE / (name + ".rs")}"] pub mod {name};' for name in actual
        )
        (crate / "src" / "lib.rs").write_text(lib + "\n", encoding="utf-8")

        print(f"checking the core for {args.target} …")
        result = subprocess.run(
            ["cargo", "check", "--target", args.target, "--quiet"],
            cwd=crate,
        )

    if result.returncode == 0:
        print(f"ok — the core compiles for {args.target}")
    else:
        print(
            f"\nFAILED for {args.target}.\n"
            f"If the errors mention a missing std, run:\n"
            f"    rustup target add {args.target}",
            file=sys.stderr,
        )
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
