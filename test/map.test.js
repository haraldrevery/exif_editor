/**
 * Map helpers, and the shape of the bundled basemap.
 *
 * The rendering itself needs a browser, but the two things that would silently
 * put a pin in the wrong place — longitude wrapping and marker derivation — are
 * pure, and the basemap is a build artefact worth asserting about.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const M = require('../www/js/map.js');

const BASEMAP = path.join(__dirname, '..', 'www', 'basemap');

/* ── Longitude wrapping ──────────────────────────────────────────────────── */

test('longitudes stay inside the range EXIF can store', () => {
  // Leaflet's worldCopyJump lets the user pan past the date line, after which
  // it reports longitudes like 190 or -543. Writing that into a file produces
  // a coordinate no other program can read.
  assert.equal(M.wrapLongitude(0), 0);
  assert.equal(M.wrapLongitude(10.7522), 10.7522);
  assert.equal(M.wrapLongitude(-70.6693), -70.6693);
  assert.equal(M.wrapLongitude(190), -170);
  assert.equal(M.wrapLongitude(-190), 170);
  // Three times round the globe.
  assert.equal(M.wrapLongitude(1080 + 25), 25);
  assert.equal(M.wrapLongitude(-1080 - 25), -25);
});

test('the date line itself resolves to a single value', () => {
  // +180 and -180 are the same meridian. Picking one keeps a round trip
  // through the file from flipping the sign each time.
  assert.equal(M.wrapLongitude(180), 180);
  assert.equal(M.wrapLongitude(-180), 180);
});

/* ── Markers ─────────────────────────────────────────────────────────────── */

test('every selected photo produces a marker entry, located or not', () => {
  const markers = M.markersFor([
    {
      SourceFile: '/photos/a.jpg',
      'Composite:GPSLatitude': 59.9139,
      'Composite:GPSLongitude': 10.7522,
    },
    { SourceFile: '/photos/b.jpg' },
  ]);
  assert.equal(markers.length, 2);
  assert.equal(markers[0].label, 'a.jpg');
  assert.deepEqual(markers[0].position, {
    latitude: 59.9139,
    longitude: 10.7522,
    altitude: null,
  });
  // Present but unlocated, so the caller can count "2 selected, 1 on the map"
  // rather than losing the photo entirely.
  assert.equal(markers[1].label, 'b.jpg');
  assert.equal(markers[1].position, null);
});

test('markers use the signed position, not the EXIF magnitude', () => {
  const markers = M.markersFor([
    {
      SourceFile: '/photos/santiago.jpg',
      'EXIF:GPSLatitude': 33.4489,
      'EXIF:GPSLatitudeRef': 'S',
      'Composite:GPSLatitude': -33.4489,
      'Composite:GPSLongitude': -70.6693,
    },
  ]);
  // Reading the EXIF value would drop the pin in the northern hemisphere.
  assert.ok(markers[0].position.latitude < 0);
  assert.ok(markers[0].position.longitude < 0);
});

test('an empty or absent selection produces no markers', () => {
  assert.deepEqual(M.markersFor([]), []);
  assert.deepEqual(M.markersFor(null), []);
});

/* ── The bundled basemap ─────────────────────────────────────────────────── */

const basemapPresent = fs.existsSync(path.join(BASEMAP, 'land.json'));

test('the basemap is valid GeoJSON with the layers the map draws', { skip: !basemapPresent }, () => {
  for (const name of ['land.json', 'borders.json', 'places.json']) {
    const data = JSON.parse(fs.readFileSync(path.join(BASEMAP, name), 'utf8'));
    assert.equal(data.type, 'FeatureCollection', `${name} is not a FeatureCollection`);
    assert.ok(data.features.length > 0, `${name} has no features`);
    for (const feature of data.features) {
      assert.ok(feature.geometry, `${name} has a feature with no geometry`);
    }
  }
});

test('the basemap stays small enough to ship', { skip: !basemapPresent }, () => {
  const total = ['land.json', 'borders.json', 'places.json']
    .map((n) => fs.statSync(path.join(BASEMAP, n)).size)
    .reduce((a, b) => a + b, 0);
  // The whole point of choosing Natural Earth over a vector-tile planet
  // extract. If this ever crosses a few megabytes, the trade needs revisiting.
  assert.ok(
    total < 4 * 1024 * 1024,
    `basemap has grown to ${(total / 1024 / 1024).toFixed(1)} MB`
  );
});

test('unused Natural Earth properties were stripped', { skip: !basemapPresent }, () => {
  const land = JSON.parse(fs.readFileSync(path.join(BASEMAP, 'land.json'), 'utf8'));
  // Land needs no attributes at all; shipping scalerank, featurecla and the
  // rest would roughly double the file for nothing.
  assert.deepEqual(land.features[0].properties, {});

  const borders = JSON.parse(fs.readFileSync(path.join(BASEMAP, 'borders.json'), 'utf8'));
  const keys = Object.keys(borders.features[0].properties);
  assert.deepEqual(keys, ['name'], `borders kept extra properties: ${keys}`);
});

test('the basemap references no remote host', { skip: !basemapPresent }, () => {
  // The app must make zero network requests; a stray URL in a data file would
  // be blocked by the CSP and show as a broken map rather than an error.
  for (const name of ['land.json', 'borders.json', 'places.json']) {
    const text = fs.readFileSync(path.join(BASEMAP, name), 'utf8');
    assert.ok(!text.includes('http://'), `${name} contains an http:// URL`);
    assert.ok(!text.includes('https://'), `${name} contains an https:// URL`);
  }
});
