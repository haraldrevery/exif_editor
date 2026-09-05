#!/usr/bin/env python3
"""(Re)create the vendored ExifTool distributions in ``vendor/``.

ExifTool is the metadata engine.  It is the only implementation that reliably
preserves MakerNotes, ICC profiles, embedded thumbnails and IFD offset tables
across every format this app touches, so it is vendored rather than assumed to
be installed — the app must behave identically on a machine that has never
heard of ExifTool.

Two distributions are needed because the platforms differ:

``exiftool-unix/``
    The plain Perl distribution (``Image-ExifTool-X.YY``).  Runs on Linux and
    macOS against the system ``perl``, which is present on effectively every
    target.  Cross-platform text, so it is also what the test suite uses.

``exiftool-windows/exiftool.exe``
    Phil Harvey's standalone Windows build.  Bundles its own Perl, so Windows
    users need nothing installed.

Both are checksum-pinned in ``CHECKSUMS`` below.  ``--check`` re-verifies what
is on disk; the Rust session layer verifies the same digest before it will
spawn the binary, so a tampered or truncated vendor tree fails closed instead
of silently editing photos with an unknown engine.

Usage::

    python build_tools/fetch_exiftool.py --check     # verify what is vendored
    python build_tools/fetch_exiftool.py --unix      # (re)fetch the Perl distro
    python build_tools/fetch_exiftool.py --windows   # (re)fetch exiftool.exe
    python build_tools/fetch_exiftool.py --all
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

EXIFTOOL_VERSION = "13.59"

# exiftool.org hosts the checksum manifest but redirects the archives
# themselves to SourceForge, which needs a redirect-following fetch.
CHECKSUM_URL = f"https://exiftool.org/checksums-{EXIFTOOL_VERSION}.txt"
SOURCEFORGE = "https://sourceforge.net/projects/exiftool/files"
UNIX_ARCHIVE = f"Image-ExifTool-{EXIFTOOL_VERSION}.tar.gz"
WINDOWS_ARCHIVE = f"exiftool-{EXIFTOOL_VERSION}_64.zip"

# sha256 of the *downloaded archives*, not the extracted trees: extraction
# timestamps and file ordering are not reproducible, archive bytes are.
#
# These are Phil Harvey's own published digests, copied from CHECKSUM_URL —
# not digests we generated from whatever we happened to download, which would
# only prove the file matches itself. On a version bump, run --print-digests
# (which re-reads the upstream manifest) and paste the result here.
CHECKSUMS = {
    UNIX_ARCHIVE: "668ea3acececb7235fbd0f4900e72d5f12c9b07e5c778fd36cb1e9b5828fd65a",
    WINDOWS_ARCHIVE: "44b512b25af500724ba579d0a53c8fc5851628b692dd5e5d94ae4a15c2cba9ec",
}

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
UNIX_DIR = VENDOR / "exiftool-unix"
WINDOWS_DIR = VENDOR / "exiftool-windows"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(name: str, dest: Path) -> Path:
    url = f"{SOURCEFORGE}/{name}/download"
    print(f"  fetching {url}")
    target = dest / name
    # SourceForge redirects to a mirror; urllib follows redirects by default.
    request = urllib.request.Request(url, headers={"User-Agent": "revery-exif-vendor"})
    with urllib.request.urlopen(request, timeout=180) as response:  # noqa: S310
        target.write_bytes(response.read())
    digest = sha256(target)
    expected = CHECKSUMS.get(name, "")
    if not expected:
        print(f"  sha256 {digest}  (no pin recorded — see --print-digests)")
    elif digest != expected:
        raise SystemExit(
            f"CHECKSUM MISMATCH for {name}\n"
            f"  expected {expected}\n  actual   {digest}\n"
            "Refusing to vendor an archive that is not the pinned release."
        )
    else:
        print(f"  sha256 ok {digest[:16]}…")
    return target


def fetch_unix() -> None:
    print("ExifTool (Perl distribution, Linux + macOS)")
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        archive = download(UNIX_ARCHIVE, tmp_path)
        with tarfile.open(archive) as tar:
            # The tarball contains a single Image-ExifTool-X.YY/ root.
            tar.extractall(tmp_path, filter="data")
        extracted = tmp_path / f"Image-ExifTool-{EXIFTOOL_VERSION}"
        if not (extracted / "exiftool").is_file():
            raise SystemExit(f"Unexpected archive layout: no exiftool in {extracted}")
        if UNIX_DIR.exists():
            shutil.rmtree(UNIX_DIR)
        # Only `exiftool` and `lib/` are needed at runtime. The rest of the
        # distribution is docs, tests and packaging metadata — several MB that
        # would otherwise land in every installer.
        UNIX_DIR.mkdir(parents=True)
        shutil.copy2(extracted / "exiftool", UNIX_DIR / "exiftool")
        (UNIX_DIR / "exiftool").chmod(0o755)
        shutil.copytree(extracted / "lib", UNIX_DIR / "lib")
        for doc in ("README", "Changes"):
            src = extracted / doc
            if src.is_file():
                shutil.copy2(src, UNIX_DIR / doc)
    print(f"  → {UNIX_DIR.relative_to(ROOT)}")


def fetch_windows() -> None:
    print("ExifTool (standalone Windows build)")
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        archive = download(WINDOWS_ARCHIVE, tmp_path)
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(tmp_path)
        # Layout is exiftool-<ver>_64/exiftool(-<ver>_64).exe + exiftool_files/
        roots = [p for p in tmp_path.iterdir() if p.is_dir() and p.name.startswith("exiftool-")]
        if len(roots) != 1:
            raise SystemExit(f"Unexpected archive layout: {[p.name for p in roots]}")
        extracted = roots[0]
        exe = next((p for p in extracted.iterdir() if p.suffix == ".exe"), None)
        if exe is None:
            raise SystemExit(f"No .exe found in {extracted}")
        if WINDOWS_DIR.exists():
            shutil.rmtree(WINDOWS_DIR)
        WINDOWS_DIR.mkdir(parents=True)
        # Phil Harvey ships it named exiftool(-k).exe / exiftool-<ver>_64.exe;
        # the trailing (-k) makes it pause for a keypress, which would hang the
        # -stay_open session. Normalise the name so the Rust side has one path.
        shutil.copy2(exe, WINDOWS_DIR / "exiftool.exe")
        files_dir = extracted / "exiftool_files"
        if files_dir.is_dir():
            shutil.copytree(files_dir, WINDOWS_DIR / "exiftool_files")
    print(f"  → {WINDOWS_DIR.relative_to(ROOT)}")


def check() -> int:
    status = 0
    unix_exe = UNIX_DIR / "exiftool"
    win_exe = WINDOWS_DIR / "exiftool.exe"
    for label, path in (("unix", unix_exe), ("windows", win_exe)):
        if path.is_file():
            print(f"ok       {label:8} {path.relative_to(ROOT)}")
        else:
            print(f"MISSING  {label:8} {path.relative_to(ROOT)}")
            status = 1
    if not (UNIX_DIR / "lib" / "Image" / "ExifTool.pm").is_file():
        print("MISSING  unix     lib/Image/ExifTool.pm")
        status = 1
    return status


def print_digests() -> None:
    """Print the pins for CHECKSUMS, read from upstream's own manifest.

    Deliberately does *not* hash a local download: a digest generated from the
    file we just fetched proves only that the file equals itself. The point of
    the pin is to carry Phil Harvey's published value into the repo, so a later
    fetch can be checked against something we did not produce.
    """
    with urllib.request.urlopen(CHECKSUM_URL, timeout=60) as response:  # noqa: S310
        manifest = response.read().decode("utf-8", "replace")
    wanted = {UNIX_ARCHIVE, WINDOWS_ARCHIVE}
    found = {}
    for line in manifest.splitlines():
        if not line.startswith("SHA2-256("):
            continue
        name, _, digest = line[len("SHA2-256("):].partition(")= ")
        if name in wanted:
            found[name] = digest.strip()
    for name in (UNIX_ARCHIVE, WINDOWS_ARCHIVE):
        if name not in found:
            raise SystemExit(f"{CHECKSUM_URL} has no SHA2-256 line for {name}")
        print(f'    "{name}": "{found[name]}",')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify the vendor tree")
    parser.add_argument("--unix", action="store_true", help="fetch the Perl distribution")
    parser.add_argument("--windows", action="store_true", help="fetch exiftool.exe")
    parser.add_argument("--all", action="store_true", help="fetch both")
    parser.add_argument("--print-digests", action="store_true", help="print sha256 pins")
    args = parser.parse_args()

    if args.print_digests:
        print_digests()
        return 0
    if args.check:
        return check()

    VENDOR.mkdir(exist_ok=True)
    did = False
    if args.unix or args.all:
        fetch_unix()
        did = True
    if args.windows or args.all:
        fetch_windows()
        did = True
    if not did:
        parser.print_help()
        return 1
    return check()


if __name__ == "__main__":
    sys.exit(main())
