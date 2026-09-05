#!/usr/bin/env python3
"""Drive the running app's UI with synthetic X input, for manual verification.

The automated suites cover every decision behind the interface, and both
JS↔Rust JSON contracts are pinned — but nothing in them clicks a button. This
closes that gap enough to check a change by hand without a full GUI test
harness.

Needs an X session and ``python3-xlib``. Wayland-only sessions have no XTEST,
so this will not work there.

Usage::

    # Where is the window? Prints: x y width height
    python3 build_tools/ui_probe.py --geometry

    # Click at absolute screen coordinates (prefix with + to hold shift)
    python3 build_tools/ui_probe.py 1180,206 190,273 +550,273

    # Screenshot the window to a file (needs ImageMagick's `import`)
    python3 build_tools/ui_probe.py --shot /tmp/app.png

A worked example — the round trip this was written to verify:

1. ``--geometry`` to locate the window.
2. Click the Map tab, then a photo, then a point on the map.
3. Click "Set this location".
4. Confirm with ``exiftool -n -G -Composite:GPSLatitude <photo>``.
5. Click "Undo last change".
6. Confirm the file's sha256 matches the original again.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time

try:
    from Xlib import X, XK, display
    from Xlib.ext import xtest
except ImportError:  # pragma: no cover - environment dependent
    print("python3-xlib is not installed; cannot drive the UI.", file=sys.stderr)
    raise SystemExit(2)

WINDOW_TITLE = "Revery Exif"


def find_window(d):
    """Finds the app window anywhere in the tree.

    Window managers reparent clients, so the app is typically two or three
    levels below the root rather than a direct child.
    """
    root = d.screen().root

    def walk(window, depth=0):
        try:
            name = window.get_wm_name()
        except Exception:
            name = None
        if name and WINDOW_TITLE in str(name):
            return window
        # Electron nests its window deeper than Tauri does, so this has to
        # reach further than the two or three levels a WM reparent adds.
        if depth >= 8:
            return None
        try:
            children = window.query_tree().children
        except Exception:
            return None
        for child in children:
            found = walk(child, depth + 1)
            if found is not None:
                return found
        return None

    return walk(root)


def geometry(d) -> tuple[int, int, int, int] | None:
    """Locates the window, preferring the window manager's own answer.

    `wmctrl -lG` reports the frame geometry the WM is actually using, which is
    what screen coordinates must be relative to. Walking the X tree works for
    Tauri but not reliably for Electron, whose window sits deeper and under a
    different client name — so the tree walk is only the fallback now.
    """
    try:
        listing = subprocess.run(
            ["wmctrl", "-lG"], capture_output=True, text=True, check=False
        ).stdout
        for line in listing.splitlines():
            if WINDOW_TITLE in line:
                parts = line.split()
                return tuple(int(v) for v in parts[2:6])  # type: ignore[return-value]
    except FileNotFoundError:
        pass

    window = find_window(d)
    if window is None:
        return None
    geom = window.get_geometry()
    coords = window.translate_coords(d.screen().root, 0, 0)
    return (-coords.x, -coords.y, geom.width, geom.height)


def click(d, x: int, y: int, shift: bool = False) -> None:
    d.screen().root.warp_pointer(x, y)
    d.sync()
    time.sleep(0.15)
    shift_code = d.keysym_to_keycode(XK.XK_Shift_L)
    if shift:
        xtest.fake_input(d, X.KeyPress, shift_code)
        d.sync()
    xtest.fake_input(d, X.ButtonPress, 1)
    d.sync()
    time.sleep(0.05)
    xtest.fake_input(d, X.ButtonRelease, 1)
    d.sync()
    if shift:
        xtest.fake_input(d, X.KeyRelease, shift_code)
        d.sync()
    # Generous: a click can trigger an ExifTool round trip and a re-render.
    time.sleep(0.6)


def type_text(d, text: str) -> None:
    """Types ASCII into whatever has focus."""
    for char in text:
        keysym = XK.string_to_keysym(
            {"-": "minus", " ": "space", ".": "period", ",": "comma"}.get(char, char)
        )
        if keysym == 0:
            continue
        code = d.keysym_to_keycode(keysym)
        needs_shift = char.isupper()
        shift_code = d.keysym_to_keycode(XK.XK_Shift_L)
        if needs_shift:
            xtest.fake_input(d, X.KeyPress, shift_code)
        xtest.fake_input(d, X.KeyPress, code)
        xtest.fake_input(d, X.KeyRelease, code)
        if needs_shift:
            xtest.fake_input(d, X.KeyRelease, shift_code)
        d.sync()
        time.sleep(0.05)
    time.sleep(0.5)


def press(d, keysym_name: str) -> None:
    """Presses a named key, e.g. Return, Tab, BackSpace, ctrl+a."""
    if keysym_name.startswith("ctrl+"):
        ctrl = d.keysym_to_keycode(XK.XK_Control_L)
        code = d.keysym_to_keycode(XK.string_to_keysym(keysym_name[5:]))
        xtest.fake_input(d, X.KeyPress, ctrl)
        xtest.fake_input(d, X.KeyPress, code)
        xtest.fake_input(d, X.KeyRelease, code)
        xtest.fake_input(d, X.KeyRelease, ctrl)
    else:
        code = d.keysym_to_keycode(XK.string_to_keysym(keysym_name))
        xtest.fake_input(d, X.KeyPress, code)
        xtest.fake_input(d, X.KeyRelease, code)
    d.sync()
    time.sleep(0.4)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geometry", action="store_true", help="print x y width height")
    parser.add_argument("--raise-window", action="store_true", help="focus the window first")
    parser.add_argument("--shot", metavar="PATH", help="screenshot after any clicks")
    parser.add_argument("--type", metavar="TEXT", help="type text after the clicks")
    parser.add_argument(
        "--press",
        metavar="KEY",
        action="append",
        default=[],
        help="press a named key (Return, Tab, BackSpace, ctrl+a); repeatable",
    )
    parser.add_argument(
        "clicks",
        nargs="*",
        help="X,Y screen coordinates; prefix with + to hold shift",
    )
    args = parser.parse_args()

    d = display.Display()

    if args.geometry:
        found = geometry(d)
        if found is None:
            print(f"No window titled {WINDOW_TITLE!r} is open.", file=sys.stderr)
            return 1
        print(" ".join(str(v) for v in found))
        return 0

    if args.raise_window or args.clicks:
        # wmctrl rather than Xlib: raising a window correctly means talking to
        # the window manager, not just restacking it.
        subprocess.run(["wmctrl", "-a", WINDOW_TITLE], check=False)
        time.sleep(1.2)

    for spec in args.clicks:
        shift = spec.startswith("+")
        x_str, _, y_str = spec.lstrip("+").partition(",")
        click(d, int(x_str), int(y_str), shift)

    if args.type:
        type_text(d, args.type)

    for key in args.press:
        press(d, key)

    if args.shot:
        time.sleep(0.8)
        subprocess.run(["import", "-window", "root", args.shot], check=True)
        print(f"wrote {args.shot}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
