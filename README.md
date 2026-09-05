# Revery Exif

A desktop editor for image metadata — EXIF, IPTC and XMP fields, and GPS
location — with a UI built around the fields people actually edit rather than a
table of four hundred tags.

**Status: complete.** Read and edit metadata across a
selection, atomically and undoably; geotag from a GPX track; place and check
locations on an offline map; shift dates for a wrong camera clock; copy
fields between photos; strip metadata for publishing. Ships as both a Tauri
and an Electron build, over one shared engine, in the Revery house style.
See [Phases](#phases).

---

## The one architectural decision

Write reliability is an *engine* problem, not a UI problem. Every GUI framework
shells out to something, and the only metadata engine that reliably preserves
MakerNotes, ICC profiles, embedded thumbnails and IFD offset tables across
formats is **ExifTool**. Pillow and piexif rewrite files and silently drop
data; Exiv2 is respectable but is a C++ cross-compile dependency with weaker
MakerNote coverage.

So the split is:

| Concern | Answer |
| --- | --- |
| Metadata engine | Bundled ExifTool, one persistent `-stay_open` process |
| UI | HTML/CSS/JS, no framework |
| Shell | Tauri v2 **and** Electron, over one shared core |

One consequence makes ExifTool the right pick for this app specifically:
`exiftool -b -PreviewImage` extracts embedded previews from HEIC and TIFF —
formats **no browser engine decodes**. It is a byte extraction, not a decode,
so it is fast enough to run per tile.

That is what the *grid* shows, and it is the right trade for a 168 px tile. It
is not enough to look at a photo with, because what comes out is typically a
160x120 EXIF thumbnail — so full preview decodes HEIC properly, with a
separately vendored libheif. See [Looking at a photo](#looking-at-a-photo).

ExifTool also has `-geotag`, and the original plan was to use it. That is not
what shipped: geotag matching is implemented in `src/gpx.rs` instead, so the
preview and the write come from the same code. See
[How geotagging works](#how-geotagging-works).

---

## Setup

Needed once, on any platform:

| | Why |
| --- | --- |
| **Node 22+** | the build scripts and the Electron shell |
| **Rust** (stable) | the metadata engine — [rustup.rs](https://rustup.rs) |
| **Python 3.9+** | fetches ExifTool and builds the basemap |

```sh
git clone <this repo> && cd revery_exif
npm install
python3 build_tools/fetch_exiftool.py --all    # ~56 MB, checksum-pinned
python3 build_tools/fetch_map_assets.py        # Leaflet + basemap (~1.9 MB)
python3 build_tools/fetch_heic_decoder.py      # HEIC decoder (~1.4 MB, optional)
python3 build_tools/make_fixtures.py           # test fixtures (~28 KB)
```

The HEIC decoder is the one optional step. Without it the app still opens,
reads and writes HEIC metadata, and shows HEIC thumbnails; only *full-size*
HEIC preview falls back to the embedded thumbnail, and says so on screen. It is
separate because it is **LGPL-3.0** where the rest of this is Apache-2.0, and
because HEVC is patent-encumbered — see
[Looking at a photo](#looking-at-a-photo).

Neither `vendor/` nor `www/vendor/` is committed. The fetch scripts restore
them against published SHA-256 digests — Phil Harvey's own for ExifTool, not
digests generated from whatever happened to download.

## Running it

```sh
npm run start:tauri                 # Tauri
npm run build:core                  # the engine the Electron shell talks to
npm run start:electron              # Electron

./tauri/target/debug/revery-exif /path/to/photos   # open a folder directly
```

> **If Electron starts and immediately throws `Cannot read properties of
> undefined (reading 'requestSingleInstanceLock')`,** your shell has
> `ELECTRON_RUN_AS_NODE=1` set — VS Code's integrated terminal does this for
> its own extension host. It makes Electron behave as plain Node, so
> `require('electron')` returns a path string instead of the module. Launch
> with `env -u ELECTRON_RUN_AS_NODE npm run start:electron`.

---

## Building installers

**You can only build for the platform you are on.** Each installer embeds a
native binary, so a Linux machine cannot produce a Windows `.exe` without a
cross-compiler — build on Windows for Windows, on macOS for macOS.

There are two shells and they produce separate installers. Pick one to ship, or
ship both and let people choose:

| | Tauri | Electron |
| --- | --- | --- |
| `.deb` / `.rpm` | **9.5 MB** | 95 MB |
| AppImage | 82 MB | 121 MB |
| Uses the system webview | yes (WebKitGTK) | no, ships Chromium |
| Renders identically | yes | yes — same `www/` |

Those are measured, not estimated. The Tauri `.deb` is small because it links
the system webview; its AppImage is large because an AppImage has to carry that
webview to stay portable. If you ship one thing, ship the Tauri `.deb`/`.rpm`.

### Step 1 — platform prerequisites

<details open>
<summary><b>Linux (.deb, .rpm, AppImage)</b></summary>

```sh
# Debian / Ubuntu
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
     libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
     rpm dpkg-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
     libappindicator-gtk3-devel librsvg2-devel rpm-build dpkg
```

`rpm` is only needed for the **Electron** `.rpm`; electron-builder shells out
to it. Tauri has its own rpm bundler and needs nothing — verified by building a
working `.rpm` on a machine with no `rpmbuild` at all.
</details>

<details>
<summary><b>Windows (.msi, .exe)</b></summary>

- **Rust with the MSVC toolchain** — `rustup default stable-msvc`
- **Visual Studio Build Tools** with "Desktop development with C++"
- **WebView2** — already present on Windows 11 and current Windows 10

Tauri downloads WiX (for `.msi`) and NSIS (for `.exe`) itself on first build.
</details>

<details>
<summary><b>macOS (.dmg)</b></summary>

```sh
xcode-select --install
```
</details>

### Step 2 — build

```sh
# Tauri — the smaller installer
npm run build:tauri

# Electron — bundles its own Chromium
npm run build:core          # must come first: the engine is a separate binary
npm run build:linux         # or build:windows / build:mac
```

### Step 3 — collect the files

| Platform | Tauri | Electron |
| --- | --- | --- |
| Linux `.deb` | `tauri/target/release/bundle/deb/` | `dist-electron/` |
| Linux `.rpm` | `tauri/target/release/bundle/rpm/` | `dist-electron/` |
| Linux AppImage | `tauri/target/release/bundle/appimage/` | `dist-electron/` |
| Windows `.msi` | `tauri/target/release/bundle/msi/` | `dist-electron/` |
| Windows `.exe` | `tauri/target/release/bundle/nsis/` | `dist-electron/` |
| macOS `.dmg` | `tauri/target/release/bundle/dmg/` | `dist-electron/` |

### Installing what you built

```sh
sudo apt install ./Revery\ Exif_0.1.0_amd64.deb     # Debian / Ubuntu
sudo dnf install ./Revery-Exif-0.1.0-1.x86_64.rpm   # Fedora
chmod +x 'Revery Exif-0.1.0.AppImage' && ./'Revery Exif-0.1.0.AppImage'
```

On Windows, `.msi` suits managed deployment and `.exe` (NSIS) is the ordinary
double-click installer that lets people choose a directory.

### If a build fails

| Symptom | Cause |
| --- | --- |
| Electron `.rpm` fails: *"Need executable 'rpmbuild'"* | install `rpm` (Debian) / `rpm-build` (Fedora). Tauri's `.rpm` is unaffected — it has its own bundler |
| electron-builder: *"configuration.linux should be one of these: null"* | an unknown key in `build.linux`. The valid ones are listed in `node_modules/app-builder-lib/scheme.json` |
| `failed to run custom build command for tauri` | the webkit2gtk dev package is missing |
| Electron build: `revery-exif-core` not found | `npm run build:core` was skipped |
| App starts, "metadata engine is missing" | `fetch_exiftool.py` was not run before building |
| `ELECTRON_RUN_AS_NODE` error | see the note above |

Nothing is code-signed, so Windows SmartScreen and macOS Gatekeeper will warn
on first run until certificates are configured in `package.json` (`build.win`,
`build.mac`) and `tauri/tauri.conf.json`.

### What has actually been built

The Linux targets are verified, not assumed: Tauri produced a `.deb`, an
`.rpm` and an AppImage, and Electron a `.deb` and an AppImage. The packages
were opened and confirmed to contain the engine and the whole ExifTool tree,
and the Tauri AppImage was launched from the bundle and used to read a HEIC —
which only works if it found its own bundled ExifTool.

The Windows and macOS targets are configured but unbuilt here: this machine has
no mingw-w64 linker, so the Rust engine cannot be cross-compiled, and an
installer without it would only prove that the packager runs.

---

A folder passed on the command line opens at launch, which is also how a file
manager's "Open with" reaches the app.

## Tests

```sh
npm test          # 190 node:test assertions — selection, fields, edits, drafts,
                  #                        coordinates, map, cache bounds, layout,
                  #                        CSV quoting and formula injection
npm run test:rust # 167 cargo assertions — session, read/write paths, batches, undo,
                  #                       geotagging, date shifts, stripping
```

Both integration suites drive the **real** ExifTool binary against real files.
The unit tests check that parsing handles a given JSON shape; these check that
ExifTool actually emits that shape, which is the assumption everything else
rests on.

`tauri/tests/write_path.rs` is the one that matters. Its central question is
not "did the tag change" but **"did anything else change"** — an engine that
quietly drops MakerNotes or an ICC profile while faithfully writing the tag you
asked for is what destroys a library, and it is invisible unless something
compares the whole tag set before and after. It also carries a canary,
`the_integrity_check_would_notice_metadata_loss`, which performs a deliberately
destructive write and asserts the comparison catches it. Without that, an
integrity test that had quietly stopped comparing anything would still pass.

Tests skip rather than fail when `vendor/` or `test/fixtures/` are absent, so a
fresh clone reports a clean run.

---

## Layout

```
www/                    frontend — shared by Tauri and any later Electron wrapper
  js/native_api.js      the only file that may touch window.__TAURI__
  js/state.js           selection + field resolution — pure, unit-tested
  js/grid.js            virtualised thumbnail grid
  js/panel.js           side panel — DOM assembly only, decisions live in state.js
  js/geotag.js          Map tab — copy location, geotag from a track
  js/map.js             offline map (Leaflet over a bundled basemap)
  js/tools.js           Tools tab — date shift, copy between photos, strip
  js/csv.js             what a CSV export contains and how it is spelled — pure
  js/export.js          the export dialog, and the chunked read behind it
  js/preview.js         full preview: zoom, pan, filmstrip
  js/preview_cache.js   the one bounded LRU both the grid and the strip share
  js/divider.js         the draggable grid/panel boundary
  js/prefs.js           the handful of settings that outlive a launch
  js/heic.js            full-size HEIC, via a worker (optional decoder)
  js/heic_worker.js     the decode itself, off the main thread
  basemap/              Natural Earth land, borders and places (~1.7 MB)
  vendor/               Leaflet (gitignored, fetched)
tauri/
  src/exiftool.rs       -stay_open session: framing, sequence numbers, respawn
  src/library.rs        scanning, metadata reading, preview extraction, GPS
  src/write.rs          the write path — copy, edit, verify, atomic rename
  src/undo.rs           hard-link snapshots of the last batch
  src/gpx.rs            track parsing, interpolation, photo matching
  src/main.rs           Tauri command wiring only
  src/serve.rs          the same core as a JSON-lines service, for Electron
electron/
  main.js               window, dialogs, IPC — wiring only
  preload.js            the only surface the renderer gets
  core_client.js        sidecar RPC: line framing and id matching
vendor/                 ExifTool (gitignored, fetched)
build_tools/            fetch_exiftool.py, fetch_map_assets.py, make_fixtures.py,
                        ui_probe.py (drives the UI for manual verification)
test/fixtures/          generated images, one per metadata edge case
```

**Invariant carried over from Revery Notebook:** the frontend never references
`window.__TAURI__` outside `native_api.js`, so an Electron wrapper is a drop-in.

### What was checked in both shells

The preview, filmstrip, divider and HEIC work was walked by hand in **both**
builds, because three of the things it depends on are shell decisions rather
than app ones and each fails in only one of them:

| | WebKitGTK (Tauri) | Chromium (Electron) |
| --- | --- | --- |
| `localStorage` on the page's origin | yes | yes — `file://`, and the width persists |
| `Worker` construction | yes | yes |
| WebAssembly under the CSP | ungated | needs `'wasm-unsafe-eval'`, present |
| `image-orientation: none` | **ignored** | **honoured** |

That last row is why the orientation suppression is scoped to `[data-orient]`.
Unscoped it looks perfect in the Tauri build and lays every rotated photo on
its side in the Electron one.

---

## Things verified against the real binary

These were each found by a test failing, not by reading documentation.

**GPS references take the signed value, not the enum.** EXIF stores latitude as
an unsigned magnitude plus a separate N/S tag. The safe way to write it is to
pass the *signed* number to both the tag and its `Ref`, letting ExifTool derive
the hemisphere:

```
-GPSLatitude=-33.4489  -GPSLatitudeRef=-33.4489     # correct
```

**This applies to altitude too, and getting it wrong fails silently.**
`-GPSAltitudeRef=1` is what the tag's own enum says for "below sea level".
ExifTool accepts it, reports success, and stores *above* sea level. Every
below-sea-level photo would read back positive with nothing reporting a
problem. `tests/read_path.rs` pins this, so if a future ExifTool fixes it the
test fails and the workaround can go.

**Read `Composite:`, write `EXIF:`.** `Composite:GPSLatitude` is signed;
`EXIF:GPSLatitude` is a magnitude. Reading the wrong one puts Santiago in the
northern hemisphere.

**The Windows ExifTool ends its lines with CRLF; the Unix one does not.** The
standalone `exiftool.exe` carries its own Perl and emits `\r\n`. A marker
compared without stripping the CR never matches, so every request would run to
its two-minute timeout and the app would appear to hang on Windows while
working perfectly everywhere else. Verified under wine and pinned by
`windows_line_endings_are_stripped`.

**A failed ExifTool request produces no stdout at all** — only the `{ready}`
terminator. Empty output is therefore never "success with no metadata"; the
framed stderr channel is the only signal, which is why it is framed rather than
merely drained.

**Do not pass `-struct`.** It makes list-typed XMP fields return arrays even
for a single value, but inconsistently — `XMP:Creator` becomes `["name"]` while
`XMP:Title` stays a bare string.

**A HEIC's own thumbnail is not extractable.** It is another HEVC-coded image
item, not an embedded JPEG, so ExifTool cannot hand it back as a picture — a
HEIC produced by a converter yields no preview at all and shows a placeholder.
What *does* work is the ordinary EXIF that phones also write, whose IFD1
thumbnail is a JPEG. So real phone photos get thumbnails and bare conversions
do not, which is the right way round but not obvious. `test/fixtures/phone.heic`
carries phone-style EXIF for exactly this reason; a HEIC without it would have
tested the wrong thing and passed.

**And that thumbnail is 1,718 bytes.** Measured, in that same fixture: 160x120,
which is a tile and not a photograph. It is easy to read "HEIC previews work"
off a grid full of them and conclude the format is handled. It is handled for
what the grid needs; looking at the picture needs a decoder, which is why there
is now one.

**An extracted preview arrives with no rotation.** The blob ExifTool hands back
is a bare JPEG; the `Orientation` that applies to it stayed behind in the
container. A webview decoding a file directly reads that tag itself and applies
it without being asked, so only the *extracted* path needs the value carried
across — `extract_preview` collects it in the same round trip. Suppressing the
webview's own orientation handling has to be scoped to exactly those images:
applied to all of them it un-rotates the ones that were already right, and only
in Chromium, which honours `image-orientation: none` where WebKitGTK ignores
it. That is a portrait photo lying on its side in the Electron build and
upright in the Tauri one, out of a stylesheet they share.

**File extensions lie.** The grid tries direct decode and preview extraction in
whichever order is more likely to work, then falls back to the other. A JPEG
saved as `.heic` decodes but has nothing to extract; a real HEIC is the reverse.

**`-gps:all=` does not remove all GPS.** It clears the EXIF block and leaves
`XMP:GPSLatitude` sitting in the file. Someone stripping location before
publishing would still be shipping their coordinates — a privacy failure, not a
tidiness one. The code uses `-GPS*=`, which covers every namespace.

**Setting a list tag appends unless you clear it first.** Writing keywords
without a leading `-XMP:Subject=` grows the list on every edit instead of
replacing it.

**`-all=` destroys the orientation flag and the ICC profile.** A photo shot
in portrait then comes out sideways in every viewer, and its colours shift.
Stripping uses `-all= -tagsfromfile @ -icc_profile -Orientation`, which puts
both back.

**A stripped JPEG legitimately keeps some EXIF.** `YCbCrPositioning` and the
resolution fields describe how to *decode* the picture, not who took it. The
strip verification therefore asserts that nothing identifying remains, not
that the tag count reached zero — the latter fails on structural tags and
says nothing about privacy.

---

## How a write works

```text
copy original → temp (same directory, hidden, .revery_exif.tmp)
edit the temp with ExifTool
re-read the temp and confirm the tags actually took
fsync the temp
rename temp over the original          ← the only mutation, and it is atomic
fsync the parent directory
```

**The original is never opened for writing.** A crash at any point leaves
either the old file or the new one — never a half-written one. The temp is a
sibling so the rename cannot cross a filesystem, which rules out `EXDEV` and
with it the copy-based fallback that would reintroduce a truncation window.

Verification is not distrust of ExifTool. A write can be reported as successful
and still not take — a tag silently ignored for a format that does not support
it, or a GPS reference written as its documented enum. Re-reading is the only
way to know, and it costs one read.

A crash mid-write leaves a stray temp. Opening a folder sweeps them up; the
originals were never at risk.

Nothing is written as you type. Edits accumulate, and **Apply always shows a
diff first** — which files, which tags, old value → new value.

## How a batch works

Two properties matter more than throughput:

1. **Every file is pre-flighted before any file is written.** A 200-photo batch
   that is going to fail on a read-only file fails before it has modified 136
   others.
2. **Per-file results, never an aggregate boolean.** If three files in fifty
   fail, the UI names them. Reporting the batch as "failed" would hide the 47
   that changed; "succeeded" would hide the 3 that did not.

## How geotagging works

Matching is done in `src/gpx.rs` rather than handed to ExifTool's `-geotag`,
for one reason: the app has to show **which photos will not be tagged, and
why**, before anything is written. A preview produced by different code than
the write is a preview that eventually lies. Doing it here also means
geotagging writes through the same verified, undoable path as every other
edit instead of being a second write mechanism.

**Time is the whole problem.** GPX timestamps are UTC and explicit.
`EXIF:DateTimeOriginal` is local wall clock with *no zone at all* —
`2024:06:15 09:41:00` could be any of twenty-odd instants. So:

- `EXIF:OffsetTimeOriginal` is used when the camera recorded it.
- Otherwise the user picks the zone, and the match count updates live as they
  change it.
- The offset is never guessed. Guessing wrong by an hour places every photo
  where the track was an hour earlier — *plausibly* wrong, which is far worse
  than obviously wrong.

Photos that do not match are listed individually with the reason — taken
before the track, after it, during a gap in the recording, or with no capture
time at all. "8 photos did not match" tells the user nothing about whether to
change the zone, extend the track, or fix a camera clock.

Two refusals worth naming:

- **Gaps are not interpolated across.** A photo taken while the receiver was
  indoors would otherwise be placed on the straight line between where the
  track stopped and resumed — a road the photographer may never have
  travelled. The tolerance is 30 minutes, matching ExifTool's own default.
- **Longitude interpolates the short way round.** Between +179° and −179°, a
  naive average travels 358° westward and lands at 0° — the Gulf of Guinea, a
  quarter of the planet from the truth.

## Exporting a CSV

The Tools tab writes one row per photo: file name, title, description, and
whichever of thirteen further columns are ticked. It is the only thing in the
app that writes to a path outside the open folder, and the only thing on that
tab that does not touch a photo at all.

Three decisions are load-bearing.

**The read is chunked, and asks for named tags.** `read_metadata` fans a whole
selection into one ExifTool call and returns the complete tag set — right for a
selection, wrong for a folder. A full `-j -G` dump is 10–25 KB per file, so four
thousand photos is tens of megabytes of JSON in one response; the engine gives a
request 120 seconds and then *retries once*, so an over-large batch does not
fail in two minutes but in four, with the ExifTool session held the whole time
and every thumbnail queued behind it. So `library::read_fields` narrows the
request to the dozen tags the chosen columns need — under half a kilobyte per
file — and `export.js` sends it 200 photos at a time, reporting progress between
batches and stopping when the button is clicked again.

Those tag names arrive from the renderer and are written straight back out as
`-{tag}` arguments, so the core checks their shape and **requires the group**.
That is not tidiness: ExifTool's own options are ungrouped words, and a bare
`execute` would become `-execute`, ending the batch early and desynchronising
the session. No option contains a colon, so insisting on `Group:Tag` removes the
whole collision rather than blacklisting the names anyone thought of.

**The renderer never names the destination.** Every path-taking command in the
app is canonicalised and confined to the open folder by `library::resolve_within`,
and an export is outside it by definition. Rather than punch a
renderer-controlled write through that guard, `export_csv` opens the native save
dialog *itself* and writes to what came back — the same shape as
`choose_gpx_file` in the other direction. It is shell-owned in both builds, so
the core still has no way to write anywhere but the library.

**A caption is not necessarily text.** Metadata comes out of files this app did
not write, and Excel and LibreOffice *execute* a value beginning with `=`, `+`,
`-` or `@` rather than displaying it. Ticked by default, the export gives those
a leading apostrophe. The guard that matters is the one on the exception: a
longitude of `-122.4` and an altitude of `-3` also begin with a minus, and
prefixing them would turn every coordinate column into text — so anything that
is wholly a number is passed through untouched. The checkbox turns the whole
thing off for anyone who needs a byte-exact dump.

The rest is RFC 4180 and the reason it exists: fields containing a comma, a
quote or a newline are quoted and their quotes doubled, lines end CRLF, and the
file opens with a BOM because Excel on Windows otherwise reads UTF-8 in the
system code page — the one platform where every accented caption comes out wrong
and nobody thinks to check. `test/csv.test.js` pins all of it, because not one
of those failures throws: the file still opens, just with the columns quietly
shifted from one row onwards.

---

## Unsaved edits survive clicking away

Type a title, click another photo by mistake, and the typing used to be gone —
silently, with nothing to undo. Edits are now held **per photo** until they are
applied: go back and it is still there, and any photo holding one carries a dot
in the corner of its tile.

**Apply still only writes what is selected.** Drafts left on other photos are
counted in the pending bar rather than swept up by a button the user pressed
while looking at something else.

Three things about this are less obvious than they look:

- **A draft stores what was typed and nothing else.** `buildEdit` decides
  set/clear/no-op by diffing against what the file holds *now*; a draft that
  carried its own baseline would keep diffing against a snapshot of the past,
  so a file changed on disk in the meantime could have a real edit quietly
  downgraded to a no-op — a save that reports success and writes nothing.
- **Selecting two photos with different drafts must not merge them.** The panel
  holds one value per field for the whole selection and shows "mixed" when they
  disagree. An early version wrote that merged view back over both drafts, and
  selecting the two photos together destroyed the edits on both — the exact
  loss the feature exists to prevent. What the panel holds is now *merged over*
  each file's draft, never substituted for it.
- **A mixed selection still has to be appliable.** The count in the pending bar
  comes from the per-file edits, not from the panel's merged one — which is
  empty in precisely that case, and hid the bar, and made Apply unreachable at
  the moment it was most needed.

**Applying goes through `write::apply_per_file`, in one call.** Not one call
per distinct edit: `undo::UndoBatch::begin` clears the previous batch, so
several calls would leave only the last one undoable — five photos edited, two
restorable. That path was already there, pre-flighted and tested, reachable
until now only through geotagging.

## Thumbnail size

`+` and `−` step the grid through four sizes. The one trap is the scale that
keeps a *rotated* thumbnail inside its tile: it is derived from the tile's
image box, and the name row's height is fixed by its font rather than scaling
with the tile, so the right factor moves from 0.80 at 120px to 0.92 at 288px. A
constant is correct at exactly one size and clips photographs at the others —
invisibly, because unrotated thumbnails look perfect throughout. grid.js
measures a real tile once per size change instead.

## Looking at a photo

Double-click a tile — or press Enter, or the toolbar button — and the grid is
replaced by one photo, a filmstrip, and the editor panel still live beside it.
That last part is the point: this is a metadata editor, and an overlay would
mean leaving the photo to change anything about it. Esc goes back, landing the
grid on the photo that was on screen.

That toolbar button is the *only* way in and out, and its label is the state:
**Preview** in the grid, **Grid** while previewing. There was briefly a second
one in the preview bar, which meant two controls for one mode change and two
places to keep in step. The thumbnail-size buttons disappear while previewing —
they resize a grid nobody can see, and disabling them would leave a dead
control where the space should be.

Preview mode can also end without anyone pressing anything: filter the
previewed photo away and there is nothing left to show. preview.js closes
itself in that case and reports it, because everything else that has to change
— the grid's tiles, the scroller, the toolbar — belongs to app.js. Closing
silently left all three in preview state with a blank window.

Scroll to zoom about the cursor, drag to pan, `0` fits, `1` is actual size, and
the arrow keys move through the folder — through the app's own selection, so
the panel, the map and the tools tab follow along without knowing preview mode
exists.

### HEIC

**No browser engine decodes HEIC.** WebKitGTK has none, and Chromium ships none
on any platform, so both shells are in the same position. The grid has always
sidestepped this by extracting the embedded EXIF thumbnail, which is a byte
copy and fast enough per tile. Full preview cannot: that thumbnail is 160x120.

So the preview decodes properly, with **libheif compiled to WebAssembly**, in a
Web Worker. Not on the main thread — a 12 MP decode is around a second, and a
second of a frozen window while somebody arrows through a folder is worse than
a thumbnail. Not in the Rust core either: linking libheif would put a C++
cross-compile back in the middle of an engine that deliberately needs nothing
but a Rust toolchain, which is the same reasoning that chose ExifTool over
Exiv2 in the first place.

Two details that are not obvious:

- **Neither shell can simply fetch a local file.** Chromium refuses `fetch` and
  `XMLHttpRequest` on `file://` whatever the CSP says, and Tauri's
  `convertFileSrc` yields an `http://asset.localhost/…` URL that the app's
  `connect-src 'self'` does not cover. The bytes go through the core instead,
  via `read_file_bytes` — one command, both shells, and the same containment
  guard every other path already uses.
- **`'wasm-unsafe-eval'` is needed in both CSP declarations**, `www/index.html`
  and `tauri/tauri.conf.json`. Chromium has gated WebAssembly compilation on it
  since Chrome 97; WebKitGTK does not gate it at all. Changing one and not the
  other produces a build that silently falls back to thumbnails in exactly one
  shell.

The **grid** uses the decoder too, but for the container's own `thmb` item
rather than its primary image — the same thing a Linux file manager reads, and
roughly a kilobyte of HEVC against a 12 MP frame. That item is typically 256x192
or 320x240, so the two numbers involved are deliberately different: tiles are
*stored* at 512 px (`THUMBNAIL_DECODE_EDGE`), but an item is worth taking from
224 px up (`THUMBNAIL_ITEM_MIN_EDGE`). Collapsing them — asking for an item of
at least 512 px, which almost no file carries — declines every real thumbnail
and decodes the full frame instead. Nothing looks wrong; the folder is just
slow. It is pinned in `test/heic_routing.test.js` for that reason.

A full-resolution decode remains the grid's **last** resort, for a HEIC out of a
converter that has neither an EXIF thumbnail nor a `thmb` item. A folder of 500
must not start 500 software HEVC decodes to draw a wall of squares. The decoded
tile is cached as a **data URI**, not a blob URL, so the preview cache's byte
budget accounts for it and nothing is left to revoke when it is evicted — and
`thumbcache.rs` keeps it across launches.

The decoder is **optional and separately licensed**. libheif and its HEVC
decoder are LGPL-3.0 against this project's Apache-2.0, and HEVC is
patent-encumbered — shipping a decoder in a distributed product is a licensing
question for the publisher, not a technical one. It is vendored whole with its
licence text, by `build_tools/fetch_heic_decoder.py`, and everything degrades
without it: HEIC metadata still reads and writes, thumbnails still show, and
the preview says what it is showing instead of pretending.

## Resizing the panel

The boundary between the grid and the editor panel drags, remembers its width,
and takes arrow keys when focused.

Two things had to be true first, and neither was:

- **A resize must not throw the grid away.** The grid rebuilt every visible
  tile whenever its container changed size, and rebuilding a tile re-ran the
  load-and-decode probe even for an image it had already resolved. On a window
  resize that is a flicker nobody notices; dragged continuously it is roughly
  thirty image decodes a frame. Resize now relays out the tiles that exist, and
  a resolved preview is painted straight from the cache.
- **The narrow-window override had to stop setting `grid-template-columns`.** A
  template in a media query outranks an inline custom property, so a panel the
  user had dragged would snap back to 300px below 980px wide and silently
  refuse to move — while the variable it was set from still held the right
  number. The override sets `--panel-width` instead, and the drag writes an
  inline value that beats both.

## Pasting a location from a map site

Copy a location in Google Maps, OpenStreetMap, Apple Maps or Bing, paste it
into the box above the map, and the pin moves there. Nothing is written until
**Set this location**.

Accepted, because people paste whatever their site put on the clipboard:

| Source | Example |
| --- | --- |
| Google "Copy coordinates" | `59.913900, 10.752200` |
| Google address bar | `.../maps/place/Oslo/@59.9139,10.7522,12z/...` |
| OpenStreetMap address bar | `.../#map=15/59.9139/10.7522` |
| OpenStreetMap share link | `.../?mlat=59.9139&mlon=10.7522#map=...` |
| `geo:` URI, Apple, Bing | `geo:59.9139,10.7522`, `?ll=`, `?cp=59.9139~10.7522` |
| Degrees/minutes/seconds | `59 deg 54' 50.0" N, 10 deg 45' 07.9" E` |

Two of these are easy to get wrong. OpenStreetMap's `#map=` puts the **zoom
first**, so reading the numbers positionally uses the zoom as a latitude; and a
share link carries both a marker (`mlat`/`mlon`) and a view centre, which are
different places -- the marker wins, because it is the one the user dropped.

A link with no coordinates in it -- Google's `maps.app.goo.gl` short links
resolve server-side -- is refused rather than guessed at. So is a signed number
carrying a hemisphere letter (`-33.4489 S`), where the sign and the letter
disagree about which hemisphere is meant.

The same parsing backs the Location field on the Edit tab, and typing there
also moves the pin, so a coordinate is visible before it reaches a file however
it arrived.

## The house style

Everything visual comes from the Revery assets rather than being invented:

- **Faces.** `HaraldText` and `HaraldMono`, copied with their licence into
  `www/fonts/`. Both are declared with a system stack behind them, so a failed
  load degrades to something readable rather than to the browser's serif.
- **Icons.** 21 glyphs from `svg_icons_to_use/`, drawn as CSS **masks** rather
  than `<img>`. A mask takes `currentColor`, so one file serves the light
  theme, the dark theme, and the inverted colours inside a primary button —
  where an `<img>` would need three copies of every glyph.
- **App mark.** "RE" in the brand face, white on a flat black square: the
  sibling of Notebook's "RN". The proportions were measured off that file
  rather than guessed — lettering spanning 77% of the canvas, and no rounded
  corners, because the rounding you see is the OS applying it at display time
  and baking it in would double it.

The type scale is a step or two larger than a system UI face would want.
HaraldText is a light display face; at the 11px that suited the placeholder
design its strokes thin out to the point of being hard to scan, and this app is
mostly small labels. `test/theme.test.js` pins the parts that fail silently:
every colour token having a light-theme value, and every icon rule carrying
both `mask-image` and `-webkit-mask-image` — WebKitGTK still needs the prefix,
and the Tauri build *is* WebKitGTK.

## The offline map

Leaflet over a bundled Natural Earth basemap: land, borders and ~200 cities,
about 1.7 MB. No tile server, no API key, no outbound request of any kind.

**This is not what the plan called for.** The plan said MapLibre over a
Protomaps `.pmtiles` basemap. Having measured both:

- A street-level planet extract is ~100 GB — not shippable. Natural Earth is
  1.7 MB and covers what the map is *for*: confirming roughly where a photo was
  taken, and dropping a pin.
- Canvas rendering needs no WebGL. WebGL does work in WebKitGTK here (WebGL
  2.0), but it varies by driver, and a map that silently fails to draw on
  someone's machine is worse than one that is a little plain everywhere.
- Leaflet is 144 KB against MapLibre's ~800 KB.

Precision never depends on the map — exact coordinates arrive by paste, by
copying between photos, or from a GPX track. Zoom is capped at 9, because
letting someone zoom to street level on a basemap that has no streets looks
broken rather than deliberately coarse.

City labels appear progressively as you zoom in, and none are drawn at world
view. Drawing all of them at once turns Europe into an illegible grey smear on
a panel this size; the dots stay visible throughout, so nothing is lost.

## Two shells, one engine

The Tauri build links the Rust core directly. Electron cannot, so it spawns the
**same binary** — `revery-exif-core --serve` — and speaks JSON lines to it.

```text
Tauri    │ www/ → invoke() → tauri/src/main.rs ─┐
                                                ├─→ lib.rs (write, undo, gpx)
Electron │ www/ → preload → main.js → sidecar ──┘
```

The alternative was reimplementing the core in Node: a second ExifTool session,
a second atomic-write path, a second undo implementation, a second GPX parser.
That would double the number of things that can be wrong about somebody's
photographs, and only one of the two would have the integrity tests.

`www/js/native_api.js` is still the only file that knows which shell it is in.
`test/shell_parity.test.js` asserts the two implement identical method sets,
that preload exposes everything the adapter calls, that every IPC channel has a
handler, and that the sidecar implements every command Tauri does — because a
method added for one shell and forgotten in the other fails only in the build
nobody was developing against.

## How undo costs nothing

Before a file is replaced, its inode is **hard-linked** into
`.revery_exif_undo/`. The write then renames a new file over the original's
name, which unlinks the old directory entry — but the inode survives, still
referenced by the link. Undo renames it back, giving a byte-identical restore.

A fifty-photo batch of 40 MB TIFFs therefore costs fifty directory entries, not
2 GB.

This rests on one invariant: **the write must create a new inode.** A hard link
preserves an inode, not a name, so it only protects against replacement by
rename. A write that truncated a file in place would mutate the very inode the
snapshot points at, and undo would silently restore the edited content as if it
were the original. `an_in_place_write_would_defeat_the_snapshot` pins this, so
the consequence is written down next to any future in-place write path rather
than discovered by someone who cannot get their photo back.

Filesystems without hard links (FAT32 on a memory card, some network mounts)
fall back to copying, bounded at 512 MB; past that the batch runs without undo
and says so. Only the most recent batch is kept, and it is discarded when the
folder is reopened — undo is a within-session promise.

---

## Phases

| Phase | Deliverable | State |
| --- | --- | --- |
| 1 | Shell, session, folder scan, thumbnail grid — read-only | **done** |
| 2 | Write path: copy → edit → verify → atomic rename, + integrity tests | **done** |
| 3 | Batch: fan one edit across a selection, per-file results, undo | **done** |
| 4 | GPS: coordinate entry, copy-to-selection, GPX geotagging | **done** |
| 5 | Offline map (Leaflet over a bundled Natural Earth basemap) | **done** |
| 6 | Date-shift, copy-from-photo, strip-metadata | **done** |
| 7 | Electron wrapper and installers | **done** |
| — | Branding: Revery glyph set, brand faces, app mark | **done** |
| — | Full preview, filmstrip, resizable panel, HEIC decoding | **done** |
| — | Thumbnail sizing, per-photo edit drafts, HEIC grid thumbnails | **done** |
| — | CSV export: chunked field reads, column picker, save dialog | **done** |
| — | Code signing certificates | outstanding |

Phase 2 was the gate, and it is passed: the write path is covered by 33
assertions including whole-tag-set integrity, image-data invariance, embedded
thumbnail survival, crash recovery, mixed-outcome batches, and the JS↔Rust
JSON contract.

Phase 7 is packaging, not features. The Electron wrapper should be close to
free — `www/js/native_api.js` is the only file that knows which shell it is
running under, so it needs a `preload.js` exposing the same method names
over `contextBridge` and an `electron/main.js` implementing the commands in
`tauri/src/main.rs`. The heavier parts are icons from the real Revery glyph
set, installer branding, and code signing.

---

## Known gaps

- **Thumbnail cache eviction is by write time, not use time.** `thumbcache.rs`
  sweeps oldest-first when the cache passes its byte budget, ordering entries by
  mtime because `atime` is coarsened or disabled (`relatime`) on most systems
  and cannot be trusted. So it evicts least-recently-*written* rather than
  least-recently-used. Wrong in theory; for a 256 MB cache of 15 KB thumbnails,
  not distinguishable in practice.

- **The `thmb` path depends on two undocumented calling conventions.** The
  vendored libheif bundle exposes its thumbnail functions as raw wasm exports
  taking integer pointers, while their immediate neighbours are embind bindings
  taking wrapper objects, and nothing in the names says which is which.
  `heif_image_handle_get_thumbnail` additionally returns a struct by value,
  which the wasm32 ABI turns into a prepended out-pointer. All three assumptions
  are pinned by `test/heic_thumbnail.test.js` against the real decoder, because
  the failure mode is silent: get it wrong and the app reports no thumbnail,
  falls back to a full-resolution decode, and still looks correct.

- **Nothing but a test watches the wasm heap.** A decode allocates a
  `heif_context` holding a copy of the whole file, and the bundle's
  `HeifDecoder.decode` frees only the context of a *previous* decode on the same
  reader — of which there is one per message. `heic_worker.js` releases it by
  hand; if that ever goes missing again the leak is invisible from JavaScript,
  survives every functional test, and surfaces only as an out-of-memory abort
  partway through a large folder, reported to the user as the decoder having
  failed. `test/heic_thumbnail.test.js` watches the allocator across 60 decodes
  for exactly this.

- **No *automated* test drives the UI**, but the round trip has been walked by
  hand with `build_tools/ui_probe.py`: click the map, Set this location,
  confirm the new coordinates on disk with `exiftool`, Undo, confirm the file's
  sha256 matches the original again. Batch editing across a multi-selection and
  the mixed-value display were exercised the same way. What is *not* covered is
  everything else — keyboard selection, the review dialog, the filter, the
  inspector.
- **Opening the app on `test/fixtures/` used to break the test suite**, because
  the read tests worked on those files in place. They now copy to a scratch
  directory first, so trying the app out on the fixture folder is harmless. If
  the fixtures do get edited, `python3 build_tools/make_fixtures.py` restores
  them.
- **`cargo build` does not re-embed the frontend.** Tauri bakes `www/` into the
  binary at compile time, and cargo sees no reason to rebuild when only HTML,
  CSS or JS changed -- so the app silently runs the previous frontend. Touch a
  Rust file (or `cargo clean -p revery-exif`) after editing `www/`. This has
  cost time twice; `npm run start:tauri` does not have the problem.
- **Date taken is shown in ExifTool's wire format** (`2024:06:15 09:41:00`),
  colons and all. It round-trips exactly, which is why it was left alone; a
  friendlier picker belongs with the date-shift tool in Phase 6.
- **RAW is deliberately out of scope.** Writing metadata into a proprietary RAW
  container is wrong; XMP sidecars are the correct answer, and that is a second
  write path with its own UI.
- **Nothing is code-signed.** Windows and macOS builds will warn on first run
  until certificates are configured in the electron-builder and Tauri configs.
- **Only the Linux build has been run.** The Electron packaging was verified by
  building and launching an AppImage. Windows and macOS are configured but
  unbuilt: this machine has no mingw-w64 linker, so `revery-exif-core.exe`
  cannot be cross-compiled, and without the engine a Windows installer would
  only prove that electron-builder runs.

  What *was* checked, under wine: the bundled `exiftool.exe` runs, reads
  metadata, and speaks the `-stay_open` protocol correctly — including its CRLF
  line endings, which the session layer now handles explicitly. That was the
  largest Windows-specific unknown. What remains untested there is the sidecar
  spawn path and the `.exe` filename in `findCore()`.

  To finish it, on a machine with the toolchain:

  ```sh
  rustup target add x86_64-pc-windows-gnu     # or msvc on Windows itself
  cargo build --manifest-path tauri/Cargo.toml --release \
        --bin revery-exif-core --target x86_64-pc-windows-gnu
  npx electron-builder --win
  ```

  Each platform ships only its own ExifTool, via `tauri/tauri.<platform>.conf.json`
  and per-platform `extraResources` in `package.json`. Both configs originally
  shipped the Unix Perl distribution to every platform, which would have
  installed a Windows build whose engine could not run at all — there is no
  system `perl` to interpret it. Worth re-checking after any packaging change:
  the failure is invisible until someone opens a folder.
