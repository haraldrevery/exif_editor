#!/usr/bin/env python3
"""Fetch the HEIC decoder into ``www/vendor/libheif/``.

**Why the app needs a decoder at all.** ExifTool already extracts what is
*inside* a HEIC, and that is what the grid's thumbnails have always been. But
extraction is a byte copy, not a decode: what comes out is the EXIF IFD1
thumbnail, which in this project's own ``test/fixtures/phone.heic`` is 1,718
bytes — 160x120 or thereabouts on a real phone photo. Fine for a 168 px tile,
useless the moment somebody wants to look at the picture. The HEIC's own
thumbnail item is HEVC-coded and cannot be handed back as a picture at all.

No browser engine decodes HEIC. WebKitGTK has no decoder, and Chromium ships
none on any platform, so both shells are in the same position.

**Why WASM rather than linking libheif into the Rust core.** The core is
deliberately buildable with nothing but a Rust toolchain — that is the whole
reason ExifTool was chosen over Exiv2 (see the README). Linking libheif would
put a C++ cross-compile back in the middle of it and make the Windows and macOS
builds materially harder. An Emscripten build costs nothing at build time,
works identically in both shells, and can simply be absent.

**Licensing, stated rather than buried.** libheif and its HEVC decoder are
**LGPL-3.0**, where this project is Apache-2.0. It is vendored whole, with its
licence text, as a separate and replaceable module — which is what keeps that
combination workable. Separately, HEVC is patent-encumbered; shipping a decoder
in a distributed product is a licensing question for the publisher, not a
technical one, and it is written down here so it is not discovered later.

The decoder is optional. Without it the app still opens, still reads and writes
HEIC metadata, and still shows extracted thumbnails; only full-size preview
falls back to the thumbnail with a note saying so.

Usage::

    python3 build_tools/fetch_heic_decoder.py            # fetch
    python3 build_tools/fetch_heic_decoder.py --check    # verify what is there
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

VERSION = "1.19.8"
TARBALL = f"https://registry.npmjs.org/libheif-js/-/libheif-js-{VERSION}.tgz"
# The published tarball, hashed on the way in. Pinned so an upstream
# replacement cannot land silently: this is a megabyte of binary that runs
# inside the app's own webview.
TARBALL_SHA256 = "bacc16fba4632b93a11ba70fc58d33ddf13a56d4afac59e4d6dae8cbf65b44fa"

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "www" / "vendor" / "libheif"

# The *bundled* wasm build: one file with the binary embedded as base64,
# exposing a `libheif` global.
#
# The alternative ships `libheif.js` (81 KB) beside `libheif.wasm` (1.0 MB) and
# is 350 KB smaller. It is not worth it. The loader resolves its `.wasm`
# sibling relative to the script's own URL, and this is loaded by a worker
# through `importScripts` — so the resolution differs between a Tauri
# `asset:`-backed origin and Electron's `file://` one, and getting it wrong
# fails at runtime in one shell only. A single file has no such question.
BUNDLE = "libheif-wasm/libheif-bundle.js"
LICENCE = "libheif-wasm/LICENSE"

FILES = {
    "libheif-bundle.js": BUNDLE,
    "LICENSE.libheif.txt": LICENCE,
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(url: str) -> bytes:
    print(f"  fetching {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "revery-exif-build"})
    with urllib.request.urlopen(request, timeout=180) as response:  # noqa: S310
        return response.read()


def install() -> None:
    print(f"libheif {VERSION} (Emscripten/WASM build, LGPL-3.0)")
    VENDOR.mkdir(parents=True, exist_ok=True)

    payload = fetch(TARBALL)
    digest = sha256(payload)
    if TARBALL_SHA256 and digest != TARBALL_SHA256:
        raise SystemExit(
            f"CHECKSUM MISMATCH for libheif-js-{VERSION}.tgz\n"
            f"  expected {TARBALL_SHA256}\n  actual   {digest}"
        )
    print(f"  sha256 ok {digest[:16]}…")

    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "libheif.tgz"
        archive.write_bytes(payload)
        with tarfile.open(archive) as tar:
            tar.extractall(tmp, filter="data")
        package = Path(tmp) / "package"
        for target, source in FILES.items():
            data = (package / source).read_bytes()
            (VENDOR / target).write_bytes(data)
            print(f"  {target}  ({len(data) // 1024} KB)")

    print(f"  → {VENDOR.relative_to(ROOT)}")


def check() -> int:
    missing = [name for name in FILES if not (VENDOR / name).is_file()]
    for name in FILES:
        path = VENDOR / name
        if path.is_file():
            print(f"ok       {path.relative_to(ROOT)}  ({path.stat().st_size // 1024} KB)")
        else:
            print(f"MISSING  {path.relative_to(ROOT)}")
    if missing:
        print(
            "\nHEIC previews will fall back to the embedded thumbnail. "
            "Run this script without --check to install the decoder.",
            file=sys.stderr,
        )
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true", help="report what is installed, fetch nothing"
    )
    args = parser.parse_args()
    if args.check:
        return check()
    install()
    return check()


if __name__ == "__main__":
    raise SystemExit(main())
