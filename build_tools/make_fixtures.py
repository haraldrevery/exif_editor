#!/usr/bin/env python3
"""Generate the metadata test fixtures in ``test/fixtures/``.

The images are synthetic gradients rather than real photographs: they are a
couple of KB each, carry no licensing question, and what is under test is the
*metadata*, not the pixels.

Each fixture isolates one thing the read and write paths must get right::

    north_gps.jpg     northern/eastern hemisphere, plus title and keywords
    south_gps.jpg     southern/western — where a sign error actually shows
    no_gps.jpg        no location at all; must never read as (0, 0)
    with_thumb.jpg    an embedded EXIF thumbnail to extract
    mixed_a/b.jpg     same tags, different values, for batch "mixed" states
    unicode.jpg       non-ASCII title and creator, for charset round-tripping
    phone.heic        a real HEIC carrying phone-style EXIF and a JPEG
                      thumbnail -- the format no browser engine decodes

The HEIC needs ``pillow-heif``, which is not required for anything else and is
awkward to install under PEP 668. It is skipped when absent, and the generated
file is committed, so only someone deliberately regenerating it needs::

    python3 -m venv .venv && .venv/bin/pip install pillow-heif
    .venv/bin/python build_tools/make_fixtures.py

Regenerate with::

    python3 build_tools/make_fixtures.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "test" / "fixtures"
EXIFTOOL = ROOT / "vendor" / "exiftool-unix" / "exiftool"


def gradient(path: Path, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> None:
    """A small vertical gradient — recognisable, and a few KB on disk."""
    width, height = 160, 120
    img = Image.new("RGB", (width, height))
    pixels = img.load()
    for y in range(height):
        t = y / (height - 1)
        colour = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(width):
            pixels[x, y] = colour
    img.save(path, "JPEG", quality=85)


def exiftool(*args: str) -> None:
    result = subprocess.run(
        [str(EXIFTOOL), "-overwrite_original", "-q", *args],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"exiftool failed: {result.stderr.strip()}")


def build_heic() -> None:
    """Writes ``phone.heic``, if pillow-heif is available.

    Why this fixture is worth the trouble: HEIC is the one format the app
    cannot fall back to letting the webview decode, so the preview-extraction
    path is the *only* way a phone photo ever shows a thumbnail. Testing that
    path against a JPEG proves nothing about it.

    What a phone writes matters too. A HEIC's own thumbnail is another
    HEVC-coded image item, which ExifTool cannot hand back as a picture — so a
    bare HEIC yields no preview at all. Phones also write ordinary EXIF, and
    the JPEG thumbnail in there *is* extractable. This fixture carries that
    EXIF, because a HEIC without it would test the wrong thing.
    """
    target = FIXTURES / "phone.heic"
    try:
        import pillow_heif  # noqa: PLC0415
    except ImportError:
        if target.is_file():
            print("  phone.heic: kept (pillow-heif not installed)")
        else:
            print("  phone.heic: SKIPPED — pip install pillow-heif to generate it")
        return

    pillow_heif.register_heif_opener()
    width, height = 640, 480
    img = Image.new("RGB", (width, height))
    pixels = img.load()
    for y in range(height):
        for x in range(width):
            pixels[x, y] = (
                int(40 + 180 * x / (width - 1)),
                int(70 + 120 * y / (height - 1)),
                150,
            )
    img.save(target, format="HEIF", quality=60, thumbnails=[256])

    thumb_source = FIXTURES / "_heic_thumb.jpg"
    gradient(thumb_source, (220, 120, 40), (250, 240, 200))
    exiftool(
        "-EXIF:Make=Apple",
        "-EXIF:Model=iPhone 15 Pro",
        "-EXIF:DateTimeOriginal=2024:06:15 09:41:00",
        "-EXIF:OffsetTimeOriginal=+02:00",
        "-GPSLatitude=59.9139",
        "-GPSLatitudeRef=59.9139",
        "-GPSLongitude=10.7522",
        "-GPSLongitudeRef=10.7522",
        f"-ThumbnailImage<={thumb_source}",
        str(target),
    )
    thumb_source.unlink()
    print(f"  phone.heic: {target.stat().st_size / 1024:.0f} KB")


def main() -> int:
    if not EXIFTOOL.is_file():
        raise SystemExit(
            "Vendored ExifTool is missing. "
            "Run: python3 build_tools/fetch_exiftool.py --all"
        )
    FIXTURES.mkdir(parents=True, exist_ok=True)

    # Oslo — northern and eastern, so both refs are positive.
    north = FIXTURES / "north_gps.jpg"
    gradient(north, (40, 70, 120), (200, 220, 240))
    exiftool(
        "-EXIF:Make=Canon",
        "-EXIF:Model=Canon EOS R6",
        "-EXIF:LensModel=RF24-105mm F4 L IS USM",
        "-EXIF:DateTimeOriginal=2024:06:15 09:41:00",
        "-EXIF:Artist=Harald Revery",
        "-XMP:Title=Fjord morning",
        "-XMP:Subject=sea",
        "-XMP:Subject=north",
        # Signed value into both the tag and its ref, so ExifTool derives the
        # hemisphere and the two cannot drift apart.
        "-GPSLatitude=59.9139",
        "-GPSLatitudeRef=59.9139",
        "-GPSLongitude=10.7522",
        "-GPSLongitudeRef=10.7522",
        "-GPSAltitude=12.5",
        "-GPSAltitudeRef=0",
        str(north),
    )

    # Santiago — southern *and* western, so both signs are negative. Sydney
    # would be the obvious choice for "southern", but it sits at 151°E, which
    # leaves the western-longitude path untested.
    south = FIXTURES / "south_gps.jpg"
    gradient(south, (120, 60, 40), (245, 210, 180))
    exiftool(
        "-EXIF:Make=Apple",
        "-EXIF:Model=iPhone 15 Pro",
        "-EXIF:DateTimeOriginal=2023:11:02 17:20:31",
        "-GPSLatitude=-33.4489",
        "-GPSLatitudeRef=-33.4489",
        "-GPSLongitude=-70.6693",
        "-GPSLongitudeRef=-70.6693",
        str(south),
    )
    # The Dead Sea, to pin the altitude convention.
    #
    # Note the signed value in the *reference* argument. `-GPSAltitudeRef=1`
    # is what the tag's own enum says for "below sea level", and ExifTool
    # accepts it, reports success — and stores "above sea level" anyway.
    dead_sea = FIXTURES / "below_sea_level.jpg"
    gradient(dead_sea, (90, 90, 60), (220, 215, 170))
    exiftool(
        "-GPSLatitude=31.5",
        "-GPSLatitudeRef=31.5",
        "-GPSLongitude=35.5",
        "-GPSLongitudeRef=35.5",
        "-GPSAltitude=-430",
        "-GPSAltitudeRef=-430",
        str(dead_sea),
    )

    # No location whatsoever.
    plain = FIXTURES / "no_gps.jpg"
    gradient(plain, (60, 60, 60), (190, 190, 190))
    exiftool("-EXIF:Make=Nikon", "-EXIF:Model=Z6", str(plain))

    # An embedded EXIF thumbnail for the preview-extraction path.
    thumb_source = FIXTURES / "_thumb_source.jpg"
    gradient(thumb_source, (200, 40, 90), (255, 240, 120))
    with_thumb = FIXTURES / "with_thumb.jpg"
    gradient(with_thumb, (30, 120, 90), (210, 245, 225))
    exiftool(f"-ThumbnailImage<={thumb_source}", str(with_thumb))
    thumb_source.unlink()

    # Two files that agree on some fields and disagree on others, for the
    # batch "mixed" resolution.
    for name, title, colour in (
        ("mixed_a.jpg", "Alpha", (30, 30, 80)),
        ("mixed_b.jpg", "Beta", (80, 30, 30)),
    ):
        path = FIXTURES / name
        gradient(path, colour, (230, 230, 230))
        exiftool(
            "-XMP:Creator=Harald Revery",  # same across both
            f"-XMP:Title={title}",  # differs
            str(path),
        )

    # Non-ASCII, to prove -charset UTF8 survives the round trip.
    unicode_file = FIXTURES / "unicode.jpg"
    gradient(unicode_file, (70, 40, 100), (225, 205, 245))
    exiftool(
        "-charset", "UTF8",
        "-XMP:Title=Vinterlys på Sognefjorden — 冬",
        "-XMP:Creator=Håkon Ødegård",
        str(unicode_file),
    )

    build_heic()

    written = sorted(p.name for p in FIXTURES.glob("*.jpg"))
    total = sum(p.stat().st_size for p in FIXTURES.glob("*.jpg"))
    print(f"wrote {len(written)} fixtures ({total / 1024:.1f} KB total):")
    for name in written:
        print(f"  {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
