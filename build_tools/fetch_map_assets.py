#!/usr/bin/env python3
"""Fetch and build the offline map assets in ``www/vendor/`` and ``www/basemap/``.

The app must work with no network at all — no tile server, no API key, no
outbound request of any kind. So the basemap is built once, here, and shipped
inside the application.

**Natural Earth, not vector tiles.** The plan called for a Protomaps
``.pmtiles`` basemap rendered with MapLibre. Having measured it, that is the
wrong trade for this app: a world basemap built from Natural Earth is about a
megabyte, renders on plain canvas with no WebGL, and is entirely adequate for
what the map is *for* — confirming roughly where a photo was taken and dropping
a pin. Street-level detail would need a ~100 GB planet extract, which is not
shippable, and WebGL under WebKitGTK is not reliable across drivers.

Exact coordinates still reach the app by other routes: paste, copy between
photos, or a GPX track. The map is an aid, never the only path.

Sources, both redistributable:

* Leaflet — BSD-2-Clause.
* Natural Earth — public domain (no permission needed, no attribution
  required, though it is offered anyway).

Usage::

    python3 build_tools/fetch_map_assets.py            # fetch and build
    python3 build_tools/fetch_map_assets.py --check    # verify what is there
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

LEAFLET_VERSION = "1.9.4"
LEAFLET_TARBALL = f"https://registry.npmjs.org/leaflet/-/leaflet-{LEAFLET_VERSION}.tgz"
LEAFLET_SHA256 = "84c65a256e50657896f54c33bd857b6849ebe94c817803be818bf32a3dde0b77"

NE_BASE = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"
)

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "www" / "vendor"
BASEMAP = ROOT / "www" / "basemap"

# Only the cities worth showing on a world map. Natural Earth ranks places by
# how early they should appear as you zoom out; 1–6 is roughly "capital or
# major city".
MAX_PLACE_RANK = 6


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(url: str) -> bytes:
    print(f"  fetching {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "revery-exif-build"})
    with urllib.request.urlopen(request, timeout=180) as response:  # noqa: S310
        return response.read()


def fetch_leaflet() -> None:
    print("Leaflet")
    VENDOR.mkdir(parents=True, exist_ok=True)
    payload = fetch(LEAFLET_TARBALL)
    digest = sha256(payload)
    if LEAFLET_SHA256 and digest != LEAFLET_SHA256:
        raise SystemExit(
            f"CHECKSUM MISMATCH for leaflet-{LEAFLET_VERSION}.tgz\n"
            f"  expected {LEAFLET_SHA256}\n  actual   {digest}"
        )
    print(f"  sha256 {digest}")

    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "leaflet.tgz"
        archive.write_bytes(payload)
        with tarfile.open(archive) as tar:
            tar.extractall(tmp, filter="data")
        dist = Path(tmp) / "package" / "dist"
        for name in ("leaflet.js", "leaflet.css"):
            (VENDOR / name).write_bytes((dist / name).read_bytes())
        # The default marker icons are referenced by leaflet.css by relative
        # path. The app draws its own markers, but the images must exist or the
        # stylesheet logs 404s on every load.
        images = VENDOR / "images"
        images.mkdir(exist_ok=True)
        for image in (dist / "images").iterdir():
            (images / image.name).write_bytes(image.read_bytes())
        licence = (Path(tmp) / "package" / "LICENSE").read_text(encoding="utf-8")
        (VENDOR / "LICENSE.leaflet.txt").write_text(licence, encoding="utf-8")
    print(f"  → {VENDOR.relative_to(ROOT)}")


def round_coords(node, precision: int):
    """Rounds coordinates in place.

    At 1e-3 degrees — roughly 100 m — the saving is large and the error is
    invisible at the zoom levels this basemap covers.
    """
    if isinstance(node, list):
        if node and isinstance(node[0], (int, float)):
            return [round(float(v), precision) for v in node]
        return [round_coords(item, precision) for item in node]
    return node


def build_basemap() -> None:
    print("Natural Earth basemap")
    BASEMAP.mkdir(parents=True, exist_ok=True)

    # Land at 50m: the coastline is what makes a map legible, and it is the one
    # layer worth the extra detail.
    land = json.loads(fetch(f"{NE_BASE}/ne_50m_land.geojson"))
    land = {
        "type": "FeatureCollection",
        "features": [
            # Geometry only. Every property Natural Earth ships (scalerank,
            # featurecla, min_zoom…) is dead weight in the bundle.
            {"type": "Feature", "properties": {}, "geometry": round_coords(f["geometry"], 3)}
            for f in land["features"]
        ],
    }

    borders = json.loads(fetch(f"{NE_BASE}/ne_110m_admin_0_countries.geojson"))
    borders = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                # The name is kept: a country label is the difference between
                # orientation and a grey blob.
                "properties": {"name": f["properties"].get("NAME") or ""},
                "geometry": round_coords(f["geometry"], 3),
            }
            for f in borders["features"]
        ],
    }

    places = json.loads(fetch(f"{NE_BASE}/ne_110m_populated_places.geojson"))
    places = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "name": f["properties"].get("NAME") or "",
                    # Natural Earth's own "how important is this place" ranking,
                    # 0 being a world capital. Kept because the map shows labels
                    # progressively as you zoom in — drawing all of them at
                    # world view is an illegible grey mass.
                    "rank": f["properties"].get("SCALERANK") or 99,
                },
                "geometry": round_coords(f["geometry"], 3),
            }
            for f in places["features"]
            if (f["properties"].get("SCALERANK") or 99) <= MAX_PLACE_RANK
        ],
    }

    total = 0
    for name, data in (("land.json", land), ("borders.json", borders), ("places.json", places)):
        # Compact separators: this is machine-read, and pretty-printing it would
        # roughly double the bundle for no benefit.
        text = json.dumps(data, separators=(",", ":"))
        path = BASEMAP / name
        path.write_text(text, encoding="utf-8")
        size = path.stat().st_size
        total += size
        print(f"  {name}: {size / 1024:.0f} KB ({len(data['features'])} features)")

    (BASEMAP / "ATTRIBUTION.md").write_text(
        "# Basemap\n\n"
        "Made with Natural Earth (naturalearthdata.com), which is in the public\n"
        "domain: free to use, adapt and redistribute, with no permission needed\n"
        "and no attribution required. Credited here anyway.\n\n"
        "Built by `build_tools/fetch_map_assets.py`, which strips every unused\n"
        "property and rounds coordinates to ~100 m.\n",
        encoding="utf-8",
    )
    print(f"  total {total / 1024:.0f} KB")


def check() -> int:
    status = 0
    expected = [
        VENDOR / "leaflet.js",
        VENDOR / "leaflet.css",
        VENDOR / "LICENSE.leaflet.txt",
        BASEMAP / "land.json",
        BASEMAP / "borders.json",
        BASEMAP / "places.json",
    ]
    for path in expected:
        if path.is_file():
            print(f"ok       {path.relative_to(ROOT)}  ({path.stat().st_size / 1024:.0f} KB)")
        else:
            print(f"MISSING  {path.relative_to(ROOT)}")
            status = 1
    return status


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify what is present")
    args = parser.parse_args()

    if args.check:
        return check()

    fetch_leaflet()
    build_basemap()
    return check()


if __name__ == "__main__":
    sys.exit(main())
