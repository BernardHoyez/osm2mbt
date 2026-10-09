/* osm2mbt – main application logic */
(function () {
  'use strict';

  // ---------- Tile sources ----------
  // OSM standard = local-language names (Vietnamese in Vietnam).
  // lima / esri / carto prioritise English or international labels.
  const TILE_SOURCES = {
    lima: {
      url: 'https://cdn.lima-labs.com/{z}/{x}/{y}.png?api=demo',
      attribution: '© OpenStreetMap contributors · Lima Labs',
      maxZoom: 18
    },
    esri: {
      // Esri uses z/y/x order in the path
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles © Esri — Source: Esri, OpenStreetMap, and others',
      maxZoom: 19
    },
    carto: {
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      attribution: '© OpenStreetMap contributors © CARTO',
      maxZoom: 20,
      subdomains: 'abcd'
    },
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
  let map, baseLayer, areaSelect = null, overlayLayer, currentBounds = null;
  let selectionActive = false;
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

    setBasemap('lima'); // default: English / anglicized labels
  }

  function isSelectionActive() {
    return !!(areaSelect && areaSelect._container && areaSelect._container.parentNode);
  }

  function enableSelection() {
    // Always create a fresh instance (plugin does not support remove + re-add cleanly)
    if (isSelectionActive()) {
      try { areaSelect.remove(); } catch (e) { /* ignore */ }
    }
    areaSelect = L.areaSelect({
      width: Math.min(280, map.getSize().x * 0.5),
      height: Math.min(200, map.getSize().y * 0.45),
      minWidth: 40,
      minHeight: 40,
      keepAspectRatio: false
    });
    areaSelect.addTo(map);
    areaSelect.on('change', updateBoundsDisplay);
    selectionActive = true;
    $('btn-select').textContent = 'Désactiver sélection';
    $('btn-select').classList.remove('secondary');
    updateBoundsDisplay();
  }

  function disableSelection() {
    if (isSelectionActive()) {
      try { areaSelect.remove(); } catch (e) { /* ignore */ }
    }
    areaSelect = null;
    selectionActive = false;
    currentBounds = null;
    bboxEl.textContent = '';
    btnGenerate.disabled = true;
    $('btn-select').textContent = 'Sélection rect.';
    $('btn-select').classList.add('secondary');
    setStatus('Sélection désactivée – cliquez sur « Sélection rect. »');
  }

  function setBasemap(key) {
    if (baseLayer) map.removeLayer(baseLayer);
    const src = TILE_SOURCES[key];
    const opts = {
      attribution: src.attribution,
      maxZoom: src.maxZoom || 18,
      crossOrigin: true
    };
    if (src.subdomains) opts.subdomains = src.subdomains;
    baseLayer = L.tileLayer(src.url, opts);
    baseLayer.addTo(map);
  }

  function updateBoundsDisplay() {
    if (!isSelectionActive()) {
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
          // Build tile URL (support both {z}/{x}/{y} and Esri-style {z}/{y}/{x})
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
      if (isSelectionActive()) {
        disableSelection();
      } else {
        enableSelection();
      }
    });

    $('btn-clear').addEventListener('click', () => {
      if (overlayLayer) {
        map.removeLayer(overlayLayer);
        overlayLayer = null;
      }
      disableSelection();
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

  // ---------- PWA install ----------
  let deferredPrompt = null;

  function setupInstall() {
    const btn = $('btn-install');
    if (!btn) return;

    // Already running as installed PWA?
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
    if (isStandalone) {
      btn.style.display = 'none';
      return;
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      btn.style.display = '';
      setStatus('Prêt à installer – cliquez sur « Installer »');
    });

    btn.addEventListener('click', async () => {
      if (!deferredPrompt) {
        // Fallback instructions
        const ua = navigator.userAgent || '';
        let tip = 'Menu du navigateur → « Installer l\'application » ou « Ajouter à l\'écran d\'accueil ».';
        if (/iPhone|iPad|iPod/.test(ua)) {
          tip = 'Safari → bouton Partager → « Sur l\'écran d\'accueil ».';
        } else if (/Firefox/.test(ua)) {
          tip = 'Firefox → menu ⋮ → « Installer ».';
        } else if (/Edg\//.test(ua)) {
          tip = 'Edge → icône ⊕ dans la barre d\'adresse, ou menu → Applications → Installer.';
        } else if (/Chrome/.test(ua)) {
          tip = 'Chrome → icône ⊕ dans la barre d\'adresse, ou menu ⋮ → « Installer osm2mbt… ».';
        }
        alert(
          'Installation non proposée automatiquement.\n\n' +
            tip +
            '\n\nSi le navigateur dit « déjà installée » :\n' +
            '1. chrome://apps (ou edge://apps) → retirer osm2mbt\n' +
            '2. Paramètres du site → Effacer les données\n' +
            '3. Recharger la page (Ctrl+Shift+R)'
        );
        return;
      }
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      deferredPrompt = null;
      btn.style.display = 'none';
      setStatus(
        choice.outcome === 'accepted'
          ? 'Application installée'
          : 'Installation annulée'
      );
    });

    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      btn.style.display = 'none';
      setStatus('Application installée');
    });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              nw.postMessage('SKIP_WAITING');
            }
          });
        });
      })
      .catch((err) => console.warn('SW registration failed', err));
  }

  // ---------- Boot ----------
  document.addEventListener('DOMContentLoaded', () => {
    initMap();
    bindUI();
    setupInstall();
    registerSW();
    setStatus('Prêt – activez la sélection rectangulaire');
  });
})();
