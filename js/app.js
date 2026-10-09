/* osm2mbt – main application logic */
(function () {
  'use strict';

  // ---------- Tile sources ----------
  const TILE_SOURCES = {
    osm: {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    },
    osmfr: {
      url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
      attribution: '© OpenStreetMap France / contributors',
      maxZoom: 20,
      subdomains: 'abc'
    },
    hot: {
      url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
      attribution: '© OpenStreetMap contributors, Humanitarian style',
      maxZoom: 20,
      subdomains: 'abc'
    }
  };

  // ---------- State ----------
  let map, baseLayer, areaSelect, overlayLayer, currentBounds = null;
  let generating = false;
  let SQL = null;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const bboxEl = $('bbox-info');
  const progressWrap = $('progress-wrap');
  const progressEl = $('progress');
  const btnGenerate = $('btn-generate');

  // ---------- Helpers ----------
  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function lon2tile(lon, z) {
    return Math.floor((lon + 180) / 360 * Math.pow(2, z));
  }
  function lat2tile(lat, z) {
    return Math.floor(
      (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) /
        2 *
        Math.pow(2, z)
    );
  }
  /** TMS y (MBTiles) from XYZ y */
  function xyzToTmsY(y, z) {
    return Math.pow(2, z) - 1 - y;
  }

  function tileCount(bounds, zmin, zmax) {
    let total = 0;
    for (let z = zmin; z <= zmax; z++) {
      const x0 = lon2tile(bounds.getWest(), z);
      const x1 = lon2tile(bounds.getEast(), z);
      const y0 = lat2tile(bounds.getNorth(), z);
      const y1 = lat2tile(bounds.getSouth(), z);
      total += (x1 - x0 + 1) * (y1 - y0 + 1);
    }
    return total;
  }

  // ---------- Map init ----------
  function initMap() {
    map = L.map('map', {
      center: [46.6, 2.4],
      zoom: 6,
      zoomControl: true
    });

    setBasemap('osm');

    // AreaSelect – rectangle centered & resizable
    areaSelect = L.areaSelect({
      width: 280,
      height: 200,
      minWidth: 40,
      minHeight: 40,
      keepAspectRatio: false
    });
    // Not added by default – user activates it

    map.on('moveend', updateBoundsDisplay);
  }

  function setBasemap(key) {
    if (baseLayer) map.removeLayer(baseLayer);
    const src = TILE_SOURCES[key];
    baseLayer = L.tileLayer(src.url, {
      attribution: src.attribution,
      maxZoom: src.maxZoom,
      subdomains: src.subdomains || '',
      crossOrigin: true
    });
    baseLayer.addTo(map);
  }

  function updateBoundsDisplay() {
    if (!areaSelect || !areaSelect._container || !areaSelect._container.parentNode) {
      currentBounds = null;
      bboxEl.textContent = '';
      btnGenerate.disabled = true;
      return;
    }
    const b = areaSelect.getBounds();
    currentBounds = b;
    const west = b.getWest().toFixed(5);
    const south = b.getSouth().toFixed(5);
    const east = b.getEast().toFixed(5);
    const north = b.getNorth().toFixed(5);
    bboxEl.textContent = `${west}, ${south}, ${east}, ${north}`;

    const zmin = +$('zmin').value;
    const zmax = +$('zmax').value;
    const n = tileCount(b, zmin, zmax);
    setStatus(`Zone sélectionnée – ~${n.toLocaleString()} tuiles (Z${zmin}–${zmax})`);
    btnGenerate.disabled = n === 0 || generating;
  }

  // ---------- GPX / KML ----------
  function loadGpxKml(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/xml');
        let geojson;
        if (file.name.toLowerCase().endsWith('.gpx') || doc.querySelector('gpx')) {
          geojson = toGeoJSON.gpx(doc);
        } else {
          geojson = toGeoJSON.kml(doc);
        }
        if (overlayLayer) map.removeLayer(overlayLayer);
        overlayLayer = L.geoJSON(geojson, {
          style: { color: '#e94560', weight: 3, opacity: 0.85 },
          pointToLayer: (f, latlng) =>
            L.circleMarker(latlng, {
              radius: 6,
              fillColor: '#e94560',
              color: '#fff',
              weight: 1,
              fillOpacity: 0.9
            })
        }).addTo(map);
        if (overlayLayer.getBounds().isValid()) {
          map.fitBounds(overlayLayer.getBounds(), { padding: [30, 30] });
        }
        setStatus(`Fichier chargé : ${file.name}`);
      } catch (err) {
        console.error(err);
        setStatus('Erreur de lecture GPX/KML');
      }
    };
    reader.readAsText(file);
  }

  // ---------- MBTiles generation ----------
  async function initSql() {
    if (SQL) return SQL;
    SQL = await initSqlJs({
      locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`
    });
    return SQL;
  }

  function createMbtilesSchema(db) {
    db.run(`
      CREATE TABLE metadata (name TEXT, value TEXT);
      CREATE TABLE tiles (
        zoom_level INTEGER,
        tile_column INTEGER,
        tile_row INTEGER,
        tile_data BLOB
      );
      CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
    `);
  }

  function putMetadata(db, meta) {
    const stmt = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(meta)) {
      stmt.run([k, String(v)]);
    }
    stmt.free();
  }

  async function fetchTile(url, retries = 2) {
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(url, {
          mode: 'cors',
          credentials: 'omit',
          referrerPolicy: 'strict-origin-when-cross-origin'
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (i === retries) throw err;
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
  }

  async function generateMbtiles() {
    if (!currentBounds || generating) return;

    const zmin = Math.max(0, Math.min(18, +$('zmin').value));
    const zmax = Math.max(zmin, Math.min(18, +$('zmax').value));
    const total = tileCount(currentBounds, zmin, zmax);

    if (total > 5000) {
      const ok = confirm(
        `Attention : ${total.toLocaleString()} tuiles.\n` +
          'Cela risque de violer la politique OSM et de faire bloquer votre IP.\n' +
          'Continuer quand même ?'
      );
      if (!ok) return;
    }

    generating = true;
    btnGenerate.disabled = true;
    progressWrap.classList.add('visible');
    progressEl.value = 0;
    setStatus('Initialisation SQLite…');

    try {
      await initSql();
      const db = new SQL.Database();
      createMbtilesSchema(db);

      const basemapKey = $('basemap').value;
      const src = TILE_SOURCES[basemapKey];
      const bounds = currentBounds;

      putMetadata(db, {
        name: 'osm2mbt',
        description: `Generated by osm2mbt – ${basemapKey}`,
        version: '1.1',
        type: 'baselayer',
        format: 'png',
        bounds: [
          bounds.getWest(),
          bounds.getSouth(),
          bounds.getEast(),
          bounds.getNorth()
        ].join(','),
        center: [
          (bounds.getWest() + bounds.getEast()) / 2,
          (bounds.getSouth() + bounds.getNorth()) / 2,
          Math.round((zmin + zmax) / 2)
        ].join(','),
        minzoom: zmin,
        maxzoom: zmax,
        attribution: src.attribution
      });

      // Build tile list
      const tasks = [];
      for (let z = zmin; z <= zmax; z++) {
        const x0 = lon2tile(bounds.getWest(), z);
        const x1 = lon2tile(bounds.getEast(), z);
        const y0 = lat2tile(bounds.getNorth(), z);
        const y1 = lat2tile(bounds.getSouth(), z);
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            tasks.push({ z, x, y });
          }
        }
      }

      const insertStmt = db.prepare(
        'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)'
      );

      const CONCURRENCY = 4; // respect OSM "max 2" spirit + small buffer
      let done = 0;
      let errors = 0;

      async function worker() {
        while (tasks.length) {
          const t = tasks.shift();
          if (!t) break;
          let url = src.url
            .replace('{z}', t.z)
            .replace('{x}', t.x)
            .replace('{y}', t.y);
          if (src.subdomains) {
            const s = src.subdomains[Math.floor(Math.random() * src.subdomains.length)];
            url = url.replace('{s}', s);
          }
          try {
            const data = await fetchTile(url);
            const tmsY = xyzToTmsY(t.y, t.z);
            insertStmt.run([t.z, t.x, tmsY, data]);
          } catch (e) {
            errors++;
            console.warn('Tile fail', t, e);
          }
          done++;
          progressEl.value = Math.round((done / total) * 100);
          if (done % 20 === 0 || done === total) {
            setStatus(`Téléchargement ${done}/${total} (erreurs: ${errors})`);
          }
        }
      }

      const workers = Array.from({ length: CONCURRENCY }, () => worker());
      await Promise.all(workers);
      insertStmt.free();

      setStatus('Export du fichier MBTiles…');
      const data = db.export();
      db.close();

      const blob = new Blob([data], { type: 'application/x-sqlite3' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.download = `osm2mbt_${ts}.mbtiles`;
      a.click();
      URL.revokeObjectURL(a.href);

      setStatus(`Terminé – ${done - errors} tuiles enregistrées${errors ? ` (${errors} erreurs)` : ''}`);
    } catch (err) {
      console.error(err);
      setStatus('Erreur : ' + err.message);
    } finally {
      generating = false;
      progressWrap.classList.remove('visible');
      btnGenerate.disabled = !currentBounds;
    }
  }

  // ---------- UI bindings ----------
  function bindUI() {
    $('basemap').addEventListener('change', (e) => setBasemap(e.target.value));

    $('btn-select').addEventListener('click', () => {
      if (areaSelect._container && areaSelect._container.parentNode) {
        areaSelect.remove();
        currentBounds = null;
        bboxEl.textContent = '';
        btnGenerate.disabled = true;
        setStatus('Sélection désactivée');
      } else {
        areaSelect.addTo(map);
        areaSelect.on('change', updateBoundsDisplay);
        updateBoundsDisplay();
      }
    });

    $('btn-clear').addEventListener('click', () => {
      if (overlayLayer) {
        map.removeLayer(overlayLayer);
        overlayLayer = null;
      }
      if (areaSelect._container && areaSelect._container.parentNode) {
        areaSelect.remove();
      }
      currentBounds = null;
      bboxEl.textContent = '';
      btnGenerate.disabled = true;
      setStatus('Carte réinitialisée');
    });

    $('btn-generate').addEventListener('click', generateMbtiles);

    $('gpxkml').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) loadGpxKml(f);
    });

    $('zmin').addEventListener('change', updateBoundsDisplay);
    $('zmax').addEventListener('change', updateBoundsDisplay);
  }

  // ---------- PWA ----------
  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('./sw.js')
        .then((reg) => {
          reg.addEventListener('updatefound', () => {
            const nw = reg.installing;
            if (nw) {
              nw.addEventListener('statechange', () => {
                if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                  // Force activation of new SW (cache-bust)
                  nw.postMessage('SKIP_WAITING');
                }
              });
            }
          });
        })
        .catch((err) => console.warn('SW registration failed', err));
    }
  }

  // ---------- Boot ----------
  document.addEventListener('DOMContentLoaded', () => {
    initMap();
    bindUI();
    registerSW();
    setStatus('Prêt – activez la sélection rectangulaire');
  });
})();
