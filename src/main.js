import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import './style.css';
import { areaLL, lengthLL, longestEdgeBearing, formatArea, formatLength } from './geo.js';
import { generateStrips } from './generate.js';
import { prepareLine, locate, pointAt, postPositions, estimateMaterial } from './guidance.js';

const $ = (id) => document.getElementById(id);
// Pont vers l'application Android (RTK natif), absent dans le navigateur
const android = window.FenceMapperAndroid || null;
const STORE_KEY = 'fencemapper.plan.v1';
const safe = (fn, dflt) => { try { return fn(); } catch { return dflt; } };

// ---------------------------------------------------------------- carte
const map = L.map('map', { zoomControl: true, maxZoom: 21 }).setView([46.6, 2.4], 6);

const tile = (url, attribution, extra = {}) =>
  L.tileLayer(url, { attribution, maxZoom: 21, maxNativeZoom: 19, crossOrigin: true, ...extra });
const basemaps = {
  ign: tile('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', '© IGN'),
  esri: tile('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', 'Imagery © Esri'),
  osm: tile('https://tile.openstreetmap.org/{z}/{x}/{y}.png', '© OpenStreetMap'),
};
let currentBase = safe(() => localStorage.getItem('fencemapper.basemap'), null) || 'ign';
if (!basemaps[currentBase]) currentBase = 'ign';
basemaps[currentBase].addTo(map);
$('basemap').value = currentBase;
$('basemap').addEventListener('change', (e) => {
  map.removeLayer(basemaps[currentBase]);
  currentBase = e.target.value;
  basemaps[currentBase].addTo(map);
  safe(() => localStorage.setItem('fencemapper.basemap', currentBase));
});

map.pm.setLang('fr');
const GEOMAN_CONTROLS = {
  position: 'topleft', drawMarker: false, drawCircleMarker: false, drawCircle: false, drawText: false,
  drawRectangle: true, drawPolygon: true, drawPolyline: true, cutPolygon: false, rotateMode: false,
  editMode: true, dragMode: true, removalMode: true,
};
map.pm.addControls(GEOMAN_CONTROLS);
map.pm.setGlobalOptions({ snappable: true, snapDistance: 15 });

const drawn = L.featureGroup().addTo(map);      // dessins de l'utilisateur (champs, clôtures)
const generated = L.featureGroup().addTo(map);  // clôtures générées (recalculées)
const guideLayer = L.featureGroup().addTo(map); // ligne cible, piquets, position

// ---------------------------------------------------------------- état
const state = {
  mode: 'design',
  selected: null,           // champ sélectionné
  genActive: false,
  genLines: [],             // clôtures générées {coords,length,label}
  strips: [],
};

const toast = (msg) => {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
};

const ringOf = (layer) => {
  let ll = layer.getLatLngs();
  while (Array.isArray(ll[0])) ll = ll[0];
  return ll.map((p) => [p.lng, p.lat]);
};
const isField = (l) => l instanceof L.Polygon;
const fields = () => drawn.getLayers().filter(isField);
const userLines = () => drawn.getLayers().filter((l) => !isField(l) && l instanceof L.Polyline);
const currentField = () => (state.selected && drawn.hasLayer(state.selected) ? state.selected : fields().slice(-1)[0] || null);

const STYLE = {
  field: { color: '#ffeb3b', weight: 3, fillColor: '#ffeb3b', fillOpacity: 0.08 },
  fieldSel: { color: '#ff9800', weight: 4, fillColor: '#ff9800', fillOpacity: 0.12 },
  line: { color: '#00e5ff', weight: 4 },
};

function styleDrawn() {
  const cur = currentField();
  drawn.eachLayer((l) => l.setStyle(isField(l) ? (l === cur ? STYLE.fieldSel : STYLE.field) : STYLE.line));
}

function register(layer) {
  const kind = isField(layer) ? 'field' : 'line';
  layer.feature = { type: 'Feature', properties: { kind }, geometry: null };
  if (!drawn.hasLayer(layer)) drawn.addLayer(layer);
  layer.on('click', () => {
    if (state.mode === 'field' && kind === 'line') return pickLine(`u:${L.stamp(layer)}`);
    if (kind === 'field') { state.selected = layer; styleDrawn(); refresh(false); }
  });
  ['pm:edit', 'pm:dragend', 'pm:vertexadded', 'pm:vertexremoved'].forEach((ev) => layer.on(ev, () => refresh()));
  styleDrawn();
}

map.on('pm:create', (e) => {
  register(e.layer);
  if (isField(e.layer)) state.selected = e.layer;
  refresh();
});
drawn.on('layerremove', () => setTimeout(() => refresh(), 0));

// ---------------------------------------------------------------- génération
const params = () => ({
  mode: $('gen-mode').value,
  value: parseFloat($('gen-value').value) || 0,
  angle: parseInt($('gen-angle').value, 10),
  reverse: $('gen-reverse').checked,
  perimeter: $('gen-perimeter').checked,
  spacing: parseFloat($('mat-spacing').value) || 10,
  rows: parseInt($('mat-rows').value, 10) || 1,
});

function regenerate() {
  generated.clearLayers();
  state.genLines = []; state.strips = [];
  const field = currentField();
  if (!state.genActive || !field) return;
  const p = params();
  const ring = ringOf(field);
  const res = generateStrips(ring, {
    bearing: p.angle, mode: p.mode, reverse: p.reverse,
    value: p.mode === 'area' ? p.value * 100 : p.value,
  });
  state.strips = res.strips;
  res.lines.forEach((l, i) => state.genLines.push({ id: `g:${i}`, coords: l.coords, length: l.length, label: `Clôture ${l.strip}` }));
  if (p.perimeter) {
    const closed = [...ring, ring[0]];
    state.genLines.push({ id: 'p:0', coords: closed, length: lengthLL(closed), label: 'Périmètre' });
  }
  for (const gl of state.genLines) {
    const isPerim = gl.id.startsWith('p');
    const pl = L.polyline(gl.coords.map(([lng, lat]) => [lat, lng]), {
      color: isPerim ? '#ffa726' : '#ff5252', weight: isPerim ? 3 : 4, dashArray: isPerim ? '2 6' : '10 6', pmIgnore: true,
    }).addTo(generated);
    pl.bindTooltip(`${gl.label} · ${formatLength(gl.length)}`, { sticky: true, className: 'strip-tip' });
    pl.on('click', () => { if (state.mode === 'field') pickLine(gl.id); });
  }
}

// ---------------------------------------------------------------- toutes les clôtures
function allLines() {
  const out = userLines().map((l, i) => {
    const coords = ringOf(l);
    return { id: `u:${L.stamp(l)}`, coords, length: lengthLL(coords), label: `Clôture dessinée ${i + 1}` };
  });
  return [...out, ...state.genLines];
}

// ---------------------------------------------------------------- panneaux d'infos
function refresh(save = true) {
  styleDrawn();
  regenerate();
  const f = currentField();
  $('field-info').innerHTML = f
    ? `Champ sélectionné : <b>${formatArea(areaLL(ringOf(f)))}</b> · périmètre ${formatLength(lengthLL([...ringOf(f), ringOf(f)[0]]))}${fields().length > 1 ? ` <small>(${fields().length} champs — cliquez pour changer)</small>` : ''}`
    : 'Aucun champ dessiné.';
  $('strip-list').innerHTML = state.strips.length
    ? `<table>${state.strips.map((s) => `<tr><td>Bande ${s.index}</td><td>${formatArea(s.area)}</td></tr>`).join('')}</table>`
    : '';
  const p = params(), lines = allLines();
  if (lines.length) {
    const m = estimateMaterial(lines.map((l) => l.length), { spacing: p.spacing, rows: p.rows });
    $('material').innerHTML = `<table>
      <tr><td>Longueur de clôture</td><td>${formatLength(m.total)}</td></tr>
      <tr><td>Piquets (tous les ${p.spacing} m)</td><td>≈ ${m.posts}</td></tr>
      <tr><td>Fil / ruban (${p.rows} rang${p.rows > 1 ? 's' : ''})</td><td>${formatLength(m.wire)}</td></tr></table>
      <small>Estimation indicative, hors portails et angles.</small>`;
  } else $('material').innerHTML = '';
  $('gen-angle-val').textContent = `${p.angle}°`;
  fillLineSelect();
  if (save) persist();
}

function persist() {
  safe(() => localStorage.setItem(STORE_KEY, JSON.stringify({ features: drawn.toGeoJSON(), params: params(), genActive: state.genActive })));
}

// ---------------------------------------------------------------- formulaire de génération
$('gen-mode').addEventListener('change', () => {
  const area = $('gen-mode').value === 'area';
  $('gen-value-label').textContent = area ? 'Surface par bande (ares, 100 a = 1 ha)' : 'Largeur (m)';
  $('gen-value').value = area ? 30 : 20;
  refresh();
});
['gen-value', 'gen-angle', 'gen-reverse', 'gen-perimeter', 'mat-spacing', 'mat-rows'].forEach((id) => $(id).addEventListener('input', () => refresh()));
$('btn-generate').addEventListener('click', () => {
  if (!currentField()) return toast('Dessinez d\'abord un champ (polygone).');
  state.genActive = true; refresh();
  const f = currentField(); map.fitBounds(f.getBounds(), { padding: [30, 30], maxZoom: 19 });
});
$('btn-clear-gen').addEventListener('click', () => { state.genActive = false; refresh(); });
$('btn-align').addEventListener('click', () => {
  const f = currentField(); if (!f) return toast('Dessinez d\'abord un champ.');
  $('gen-angle').value = longestEdgeBearing(ringOf(f)); refresh();
});

// ---------------------------------------------------------------- import / export / reset
function loadFeatures(fc) {
  const layers = [];
  L.geoJSON(fc, {
    filter: (f) => !['generated', 'perimeter'].includes(f.properties?.kind),
    onEachFeature: (_, l) => layers.push(l),
  });
  for (const l of layers) if (l instanceof L.Polyline) register(l);
  return layers.length;
}

$('btn-export').addEventListener('click', () => {
  const fc = drawn.toGeoJSON();
  generated.eachLayer((l, i) => { /* lignes générées incluses pour les SIG */ });
  state.genLines.forEach((gl) => fc.features.push({ type: 'Feature', properties: { kind: 'generated', label: gl.label, length_m: Math.round(gl.length) }, geometry: { type: 'LineString', coordinates: gl.coords } }));
  fc.fencemapper = { version: 1, params: params(), genActive: state.genActive };
  const name = `fencemapper-${new Date().toISOString().slice(0, 10)}.geojson`;
  if (android) return android.saveFile(name, JSON.stringify(fc));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }));
  a.download = name;
  a.click(); URL.revokeObjectURL(a.href);
});
$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const fc = JSON.parse(await file.text());
    const n = loadFeatures(fc);
    if (fc.fencemapper?.params) applyParams(fc.fencemapper.params);
    state.genActive = !!fc.fencemapper?.genActive;
    refresh();
    if (drawn.getLayers().length) map.fitBounds(drawn.getBounds(), { padding: [30, 30] });
    toast(`${n} élément(s) importé(s).`);
  } catch { toast('Fichier GeoJSON invalide.'); }
});
$('btn-reset').addEventListener('click', () => {
  if (!confirm('Tout effacer (champs, clôtures et génération) ?')) return;
  drawn.clearLayers(); state.selected = null; state.genActive = false; refresh();
});

function applyParams(p) {
  if (!p) return;
  $('gen-mode').value = p.mode || 'width';
  $('gen-value-label').textContent = p.mode === 'area' ? 'Surface par bande (ares, 100 a = 1 ha)' : 'Largeur (m)';
  $('gen-value').value = p.value ?? 20; $('gen-angle').value = p.angle ?? 90;
  $('gen-reverse').checked = !!p.reverse; $('gen-perimeter').checked = p.perimeter !== false;
  $('mat-spacing').value = p.spacing ?? 10; $('mat-rows').value = p.rows ?? 1;
}

// ---------------------------------------------------------------- ma position
$('btn-locate').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Géolocalisation indisponible.');
  navigator.geolocation.getCurrentPosition(
    (p) => map.setView([p.coords.latitude, p.coords.longitude], 17),
    () => toast('Position refusée ou indisponible.'), { enableHighAccuracy: true, timeout: 15000 });
});

// ================================================================ MODE TERRAIN
const gps = { watch: null, wake: null, last: null, target: 'auto', reversed: false, prep: null, prepKey: '', postIdx: 0, lines: [] };

function fillLineSelect() {
  const sel = $('target-line');
  const prev = gps.target;
  gps.lines = allLines();
  sel.innerHTML = `<option value="auto">Ligne la plus proche (auto)</option>` +
    gps.lines.map((l) => `<option value="${l.id}">${l.label} · ${formatLength(l.length)}</option>`).join('');
  sel.value = gps.lines.some((l) => l.id === prev) || prev === 'auto' ? prev : 'auto';
  gps.target = sel.value;
}
function pickLine(id) { gps.target = id; $('target-line').value = id; gps.postIdx = 0; gps.prepKey = ''; if (gps.last) update(); else drawTarget(); }
$('target-line').addEventListener('change', (e) => pickLine(e.target.value));
$('btn-reverse-line').addEventListener('click', () => { gps.reversed = !gps.reversed; gps.postIdx = 0; gps.prepKey = ''; update(); toast(gps.reversed ? 'Sens inversé' : 'Sens d\'origine'); });
$('btn-post-next').addEventListener('click', () => { gps.postIdx++; update(); });
$('btn-post-prev').addEventListener('click', () => { gps.postIdx = Math.max(0, gps.postIdx - 1); update(); });

function chooseLine(ll) {
  const lines = gps.lines;
  if (!lines.length) return null;
  if (gps.target !== 'auto') return lines.find((l) => l.id === gps.target) || null;
  const cur = lines.find((l) => l.id === gps.autoId);
  const dist = (l) => locate(prepareLine(l.coords), ll).dist;
  if (cur && dist(cur) < 15) return cur;
  let best = lines[0], bd = Infinity;
  for (const l of lines) { const d = dist(l); if (d < bd) { bd = d; best = l; } }
  if (best.id !== gps.autoId) { gps.autoId = best.id; gps.postIdx = 0; gps.prepKey = ''; }
  return best;
}

const fmt1 = (m) => (m < 10 ? m.toFixed(1) : Math.round(m)).toString().replace('.', ',');
const postMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div style="font-size:30px;line-height:1;transform:translate(-50%,-100%)">📌</div>', iconSize: [0, 0] }) });
const me = L.marker([0, 0], { interactive: false, zIndexOffset: 1000, icon: L.divIcon({ className: 'quad-icon', html: '<div id="me-arrow">🔵</div>', iconSize: [28, 28], iconAnchor: [14, 14] }) });
let targetPoly = null, postDots = [];

function drawTarget() {
  guideLayer.clearLayers(); targetPoly = null; postDots = [];
  const line = gps.target === 'auto' ? gps.lines.find((l) => l.id === gps.autoId) : gps.lines.find((l) => l.id === gps.target);
  if (!line) return;
  targetPoly = L.polyline(line.coords.map(([lng, lat]) => [lat, lng]), { color: '#fff', weight: 7, opacity: 0.9, interactive: false }).addTo(guideLayer);
}

function update() {
  const ll = gps.last; if (!ll) return;
  const line = chooseLine(ll);
  const steer = $('steer'), sub = $('steer-sub');
  if (!line) { steer.textContent = '—'; steer.className = 'steer'; sub.textContent = 'Aucune clôture à suivre : dessinez ou générez-en.'; return; }
  const p = params();
  const key = `${line.id}|${gps.reversed}|${p.spacing}`;
  if (key !== gps.prepKey) {
    gps.prep = prepareLine(gps.reversed ? [...line.coords].reverse() : line.coords);
    gps.posts = postPositions(gps.prep.length, p.spacing);
    gps.prepKey = key; gps.postIdx = Math.min(gps.postIdx, gps.posts.length);
    drawTarget();
    postDots.forEach((d) => d.remove());
    postDots = gps.posts.map((s) => { const q = pointAt(gps.prep, s); return L.circleMarker([q[1], q[0]], { radius: 4, color: '#fff', weight: 2, fillColor: '#e53935', fillOpacity: 1, interactive: false }).addTo(guideLayer); });
  }
  const loc = locate(gps.prep, ll);
  const abs = Math.abs(loc.cross);
  // cross > 0 : à droite de la ligne -> corriger vers la gauche
  steer.textContent = abs < 0.1 ? '✔' : `${loc.cross > 0 ? '←' : '→'} ${fmt1(abs)} m`;
  steer.className = 'steer ' + (abs < 0.3 ? 'ok' : abs < 1 ? 'warn' : 'bad');
  sub.textContent = abs < 0.1 ? 'Sur la ligne' : `${loc.cross > 0 ? 'À droite' : 'À gauche'} de la ligne — aller ${loc.cross > 0 ? 'à gauche' : 'à droite'}`;

  $('post-total').textContent = gps.posts.length;
  $('post-idx').textContent = Math.min(gps.postIdx + 1, gps.posts.length);
  if (gps.postIdx >= gps.posts.length) {
    $('st-next').textContent = '✔'; postMarker.remove();
  } else {
    const s = gps.posts[gps.postIdx], ahead = s - loc.along;
    $('st-next').textContent = `${ahead >= 0 ? '' : '↩ '}${fmt1(Math.abs(ahead))} m`;
    const q = pointAt(gps.prep, s); postMarker.setLatLng([q[1], q[0]]).addTo(guideLayer);
  }
  $('st-left').textContent = formatLength(Math.max(0, gps.prep.length - loc.along));
  postDots.forEach((d, i) => d.setStyle({ fillColor: i < gps.postIdx ? '#43a047' : '#e53935' }));
}

function onPos(pos) {
  const c = pos.coords;
  gps.last = [c.longitude, c.latitude];
  const ll = [c.latitude, c.longitude];
  me.setLatLng(ll).addTo(guideLayer);
  const arrow = document.getElementById('me-arrow');
  if (arrow) {
    if (c.heading != null && !Number.isNaN(c.heading) && (c.speed ?? 0) > 0.5) { arrow.textContent = '⬆️'; arrow.style.transform = `rotate(${c.heading}deg)`; }
    else { arrow.textContent = '🔵'; arrow.style.transform = ''; }
  }
  const acc = c.accuracy == null ? '—' : c.accuracy < 1 ? `±${Math.round(c.accuracy * 100)} cm` : `±${fmt1(c.accuracy)} m`;
  $('st-acc').textContent = acc;
  $('st-acc').className = pos.quality ? `q-${pos.quality}` : '';
  $('st-acc-label').textContent = pos.qualityLabel || 'précision GPS';
  if (!gps.centered) { map.setView(ll, Math.max(map.getZoom(), 19)); gps.centered = true; }
  else if (!map.getBounds().pad(-0.25).contains(ll)) map.panTo(ll);
  update();
}

async function startGps() {
  if ($('sim').checked) { toast('Mode simulation : cliquez sur la carte pour placer le quad.'); setGpsButton(true); return; }
  gps.centered = false;
  if (android) { android.start(); setGpsButton(true); return; }
  if (!navigator.geolocation) return toast('Géolocalisation indisponible sur cet appareil.');
  gps.watch = navigator.geolocation.watchPosition(onPos,
    (e) => toast(e.code === 1 ? 'Accès à la position refusé.' : 'Signal GPS indisponible.'),
    { enableHighAccuracy: true, maximumAge: 500, timeout: 20000 });
  safe(async () => { gps.wake = await navigator.wakeLock?.request('screen'); });
  setGpsButton(true);
}
function stopGps() {
  if (android) android.stop();
  if (gps.watch != null) navigator.geolocation.clearWatch(gps.watch);
  gps.watch = null; safe(() => gps.wake?.release()); gps.wake = null;
  setGpsButton(false);
}
function setGpsButton(on) { gps.on = on; $('btn-gps').textContent = on ? '■ Arrêter le GPS' : '▶ Démarrer le GPS'; }
$('btn-gps').addEventListener('click', () => (gps.on ? stopGps() : startGps()));
map.on('click', (e) => { if (state.mode === 'field' && $('sim').checked) { gps.centered = true; onPos({ coords: { latitude: e.latlng.lat, longitude: e.latlng.lng, accuracy: 2, heading: null, speed: 0 } }); } });
document.addEventListener('visibilitychange', async () => { if (!document.hidden && gps.on && gps.watch != null) safe(async () => { gps.wake = await navigator.wakeLock?.request('screen'); }); });

// ---------------------------------------------------------------- RTK natif (application Android)
window.fmNative = {
  onPosition(p) {
    if ($('sim').checked) return;
    onPos({ quality: p.quality, qualityLabel: p.label,
      coords: { latitude: p.lat, longitude: p.lon, accuracy: p.acc, heading: p.bearing, speed: p.speed } });
  },
  onStatus(s) {
    const order = ['mode', 'rtk', 'ntrip', 'base', 'signaux', 'brutes', 'bt', 'gps'];
    $('rtk-status').innerHTML = order.filter((k) => s[k]).map((k) => `<div>${s[k].replace(/</g, '&lt;')}</div>`).join('');
  },
};
if (android) {
  $('btn-rtk').hidden = false;
  $('btn-rtk').addEventListener('click', () => { stopGps(); android.openSettings(); });
}

// ---------------------------------------------------------------- onglets
function setMode(mode) {
  state.mode = mode;
  const design = mode === 'design';
  $('tab-design').classList.toggle('active', design); $('tab-field').classList.toggle('active', !design);
  $('panel-design').classList.toggle('hidden', !design); $('panel-field').classList.toggle('hidden', design);
  map.pm.disableDraw(); map.pm.disableGlobalEditMode(); map.pm.disableGlobalDragMode?.(); map.pm.disableGlobalRemovalMode?.();
  if (design) { map.pm.addControls(GEOMAN_CONTROLS); guideLayer.clearLayers(); targetPoly = null; }
  else { map.pm.removeControls(); fillLineSelect(); gps.prepKey = ''; drawTarget(); if (gps.last) update(); }
  setTimeout(() => map.invalidateSize(), 50);
}
$('tab-design').addEventListener('click', () => setMode('design'));
$('tab-field').addEventListener('click', () => setMode('field'));

// ---------------------------------------------------------------- démarrage
const saved = safe(() => JSON.parse(localStorage.getItem(STORE_KEY)), null);
if (saved) {
  applyParams(saved.params);
  loadFeatures(saved.features);
  state.genActive = !!saved.genActive;
  if (drawn.getLayers().length) map.fitBounds(drawn.getBounds(), { padding: [30, 30], maxZoom: 18 });
}
refresh(false);
window.__fm = { map, drawn, state, gps, register, refresh, onPos, setMode, L }; // utile pour les tests

if (import.meta.env.PROD && !android && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
