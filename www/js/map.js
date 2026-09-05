/**
 * map.js — the offline map.
 *
 * Leaflet over a bundled Natural Earth basemap. No tile server, no API key, no
 * outbound request of any kind: the app makes zero network calls by design, and
 * the CSP forbids them anyway.
 *
 * # Why not vector tiles
 *
 * The plan called for MapLibre over a Protomaps `.pmtiles` basemap. Having
 * measured both, this is the better trade:
 *
 *   * The whole basemap is ~1.7 MB of GeoJSON. A street-level planet extract is
 *     ~100 GB and is not shippable at all.
 *   * Canvas rendering needs no WebGL. WebGL works in WebKitGTK here, but it
 *     varies by driver, and a map that silently fails to draw on someone's
 *     machine is worse than one that is a little plain everywhere.
 *   * Leaflet is 144 KB against MapLibre's ~800 KB, for a map whose job is
 *     confirming roughly where a photo was taken.
 *
 * Exact coordinates reach the app by other routes — paste, copy between photos,
 * or a GPX track — so precision never depends on the map. It is an aid, and the
 * app is fully usable with it absent.
 */

(function () {
  'use strict';

  // Loaded both as a browser global and by test/map.test.js under node, so the
  // pure helpers at the bottom are testable without a window.
  const S =
    typeof window !== 'undefined' && window.ExifState
      ? window.ExifState
      : require('./state.js');

  function report(detail) {
    try {
      if (typeof window !== 'undefined' && window.NativeAPI) {
        window.NativeAPI.reportRenderer(detail);
      }
    } catch (_) { /* diagnostic only */ }
  }

  /** Below this zoom no city labels are drawn at all — only the dots. */
  const LABEL_MIN_ZOOM = 4;

  /** Basemap colours, resolved from the app's own custom properties. */
  function palette() {
    const style = getComputedStyle(document.documentElement);
    const read = (name, fallback) =>
      (style.getPropertyValue(name) || '').trim() || fallback;
    return {
      water: read('--bg', '#16181c'),
      land: read('--surface-raised', '#24282e'),
      border: read('--border-strong', '#414852'),
      place: read('--text-faint', '#6b727b'),
      accent: read('--accent', '#d9a05b'),
      text: read('--text', '#e8e6e1'),
    };
  }

  function createMap({ container, onPick, setStatus }) {
    let map = null;
    let markers = [];
    let pending = null;
    let failed = false;
    let basemapLoaded = false;
    let placeFeatures = [];
    let labels = [];

    /** Loads the bundled basemap once, then draws it. */
    async function loadBasemap() {
      if (basemapLoaded) return;
      const colours = palette();
      const layers = [
        { file: 'land.json', style: { stroke: false, fillColor: colours.land, fillOpacity: 1 } },
        {
          file: 'borders.json',
          style: { color: colours.border, weight: 1, fill: false, opacity: 0.8 },
        },
      ];
      const counts = [];
      for (const layer of layers) {
        const response = await fetch(`basemap/${layer.file}`);
        if (!response.ok) throw new Error(`basemap/${layer.file}: ${response.status}`);
        const data = await response.json();
        counts.push(`${layer.file} ${data.features.length}`);
        // Canvas rather than SVG: 1400 land polygons as DOM nodes makes panning
        // stutter, and none of them need to be individually interactive.
        L.geoJSON(data, { style: layer.style, interactive: false, renderer: L.canvas() }).addTo(map);
      }

      const places = await (await fetch('basemap/places.json')).json();
      // Dots always: they are 1.5 px and give the eye something to orient by
      // without any text.
      L.geoJSON(places, {
        interactive: false,
        renderer: L.canvas(),
        pointToLayer: (feature, latlng) =>
          L.circleMarker(latlng, {
            radius: 1.5,
            color: colours.place,
            fillColor: colours.place,
            fillOpacity: 0.9,
            weight: 0,
            interactive: false,
          }),
      }).addTo(map);
      placeFeatures = places.features;
      map.on('zoomend', renderLabels);
      renderLabels();
      counts.push(`places.json ${places.features.length}`);

      basemapLoaded = true;
      // Reported for the same reason as the WebGL probe: "the map is blank" is
      // otherwise indistinguishable between a missing basemap, a CSP block and
      // a zero-sized container.
      report(`basemap: loaded (${counts.join(', ')})`);
    }

    async function ensureMap() {
      if (map || failed) return map;
      if (typeof L === 'undefined') {
        failed = true;
        container.innerHTML =
          '<p class="panel-hint">The map could not load. ' +
          'Run <code>python3 build_tools/fetch_map_assets.py</code>.</p>';
        return null;
      }
      map = L.map(container, {
        // No attribution control: it renders a link, and this app must never
        // act as a browser. Credit lives in basemap/ATTRIBUTION.md instead.
        attributionControl: false,
        worldCopyJump: true,
        minZoom: 1,
        // The bundled basemap has no detail past roughly this point; letting
        // the user zoom to street level would show an empty grey field and
        // look broken rather than deliberately coarse.
        maxZoom: 9,
        zoomControl: true,
      }).setView([20, 0], 2);
      map.getContainer().style.background = palette().water;

      map.on('click', (event) => {
        const position = {
          latitude: Number(event.latlng.lat.toFixed(6)),
          longitude: Number(wrapLongitude(event.latlng.lng).toFixed(6)),
        };
        onPick(position);
      });

      try {
        await loadBasemap();
      } catch (error) {
        report(`basemap: FAILED — ${error.message || error}`);
        setStatus(`The basemap could not load: ${error.message || error}`, true);
      }
      return map;
    }

    /**
     * Draws city labels for the current zoom.
     *
     * Every label at once is an illegible grey mass on a panel this size — at
     * world view the whole of Europe becomes a smear. Natural Earth ranks each
     * place by importance (0 = world capital), so labels appear progressively:
     * none at world view, capitals as you zoom in, more after that. The dots
     * stay visible throughout, so nothing is lost.
     */
    function renderLabels() {
      if (!map) return;
      for (const label of labels) label.remove();
      labels = [];
      const zoom = map.getZoom();
      if (zoom < LABEL_MIN_ZOOM) return;
      const maxRank = zoom - LABEL_MIN_ZOOM;
      const colours = palette();
      for (const feature of placeFeatures) {
        if ((feature.properties.rank ?? 99) > maxRank) continue;
        const [lng, lat] = feature.geometry.coordinates;
        const label = L.marker([lat, lng], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: 'map-place-label',
            html: feature.properties.name,
            iconSize: null,
          }),
        }).addTo(map);
        labels.push(label);
      }
      void colours;
    }

    function clearMarkers() {
      for (const marker of markers) marker.remove();
      markers = [];
    }

    function addMarker(position, { label, kind }) {
      const colours = palette();
      const isPending = kind === 'pending';
      const marker = L.circleMarker([position.latitude, position.longitude], {
        radius: isPending ? 7 : 5,
        color: isPending ? colours.accent : colours.text,
        fillColor: colours.accent,
        fillOpacity: isPending ? 1 : 0.75,
        weight: 2,
      }).addTo(map);
      if (label) marker.bindTooltip(label, { direction: 'top' });
      markers.push(marker);
      return marker;
    }

    return {
      /**
       * Draws the current selection.
       *
       * `positions` are the saved locations; `preview` is an unsaved one the
       * user is placing, drawn larger so it is obvious which is which.
       */
      async render(positions, preview) {
        const instance = await ensureMap();
        if (!instance) return;
        // Leaflet measures the container on creation; the Map tab is hidden at
        // that point, so it comes out zero-sized until told to re-measure.
        instance.invalidateSize();

        clearMarkers();
        for (const item of positions) {
          if (!item.position) continue;
          addMarker(item.position, { label: item.label, kind: 'saved' });
        }
        pending = preview || null;
        if (pending) addMarker(pending, { label: 'New location', kind: 'pending' });

        const points = positions
          .filter((p) => p.position)
          .map((p) => [p.position.latitude, p.position.longitude]);
        if (pending) points.push([pending.latitude, pending.longitude]);

        if (points.length === 1) {
          instance.setView(points[0], Math.max(instance.getZoom(), 6));
        } else if (points.length > 1) {
          instance.fitBounds(L.latLngBounds(points).pad(0.25));
        }
      },

      /** Re-measures after the tab becomes visible. */
      async refreshSize() {
        const instance = await ensureMap();
        if (instance) instance.invalidateSize();
      },
    };
  }

  /* ── Pure helpers, unit-tested in test/map.test.js ─────────────────────── */

  /** Marker data for a selection: one entry per photo, located or not. */
  function markersFor(entries) {
    return (entries || []).map((entry) => ({
      label: S.basename(entry && entry.SourceFile),
      position: S.positionOf(entry),
    }));
  }

  /**
   * Normalises a longitude into [-180, 180].
   *
   * `worldCopyJump` lets the user pan past the date line, after which Leaflet
   * reports longitudes like 190 or -543. Writing that into EXIF would produce
   * a coordinate no other program can read.
   */
  function wrapLongitude(lng) {
    // Already in range: return it untouched. Running an in-range value through
    // the modulo below perturbs it in the last bits — 10.7522 comes back as
    // 10.752200000000016 — which then shows up as spurious digits in the UI
    // and in the file.
    if (lng > -180 && lng <= 180) return lng;
    let value = (((lng + 180) % 360) + 360) % 360 - 180;
    if (value === -180) value = 180;
    return value;
  }

  const api = { createMap, markersFor, wrapLongitude };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    window.ExifMap = api;
  }
})();
