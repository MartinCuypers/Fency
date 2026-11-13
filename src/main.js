import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import './style.css';
import { areaLL, lengthLL, longestEdgeBearing, formatArea, formatLength } from './geo.js';
import { generateStrips } from './generate.js';
import { prepareLine, locate, pointAt, estimateMaterial, toStart, bearingAt, nextPhase, nearerEndIsLast } from './guidance.js';
import { startCompass, angleDiff } from './compass.js';
import { makeCamera, toCameraFrame, drawScene } from './perspective.js';
import { createBackend, readConfig } from './backends/index.js';
import { uid } from './backends/types.js';
import { createSession } from './session.js';
import { loadLayerSpecs, tileUrl, tileOptions, wfsUrl, normalizeWfs, outerRingAt, BBOX_VARIANTS, catalogPlan, parseWfsEndpoint, parseWfsCapabilities, searchCatalog, layerLabel, wfsSpecLine } from './layers.js';

const $ = (id) => document.getElementById(id);
// Pont vers l'application Android (RTK natif), absent dans le navigateur
const android = window.FencyAndroid || null;
const LEGACY_KEY = 'fency.plan.v1'; // plan unique des versions sans liste de plans
const safe = (fn, dflt) => { try { return fn(); } catch { return dflt; } };
const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// reprise des données enregistrées sous l'ancien nom (FenceMapper)
safe(() => { for (const k of ['plan.v1', 'basemap']) { const o = localStorage.getItem('fencemapper.' + k); if (o && !localStorage.getItem('fency.' + k)) localStorage.setItem('fency.' + k, o); } });

// ---------------------------------------------------------------- carte
const map = L.map('map', { zoomControl: true, maxZoom: 21 }).setView([46.6, 2.4], 6);

// couches ajoutées par l'utilisateur depuis le catalogue d'un serveur (mémorisées sur l'appareil)
let customLayers = safe(() => JSON.parse(localStorage.getItem('fency.customLayers')), null) ?? [];
const readLayers = () => loadLayerSpecs([import.meta.env.VITE_FENCY_LAYERS, ...customLayers].filter(Boolean).join('|'));
let layerSpecs = readLayers();
const basemaps = Object.fromEntries(layerSpecs.basemaps.map((spec) =>
  [spec.id, L.tileLayer(tileUrl(spec), { maxZoom: 21, crossOrigin: true, ...tileOptions(spec) })]));
$('basemap').innerHTML = layerSpecs.basemaps.map((b) => `<option value="${b.id}">${b.label}</option>`).join('');
let currentBase = safe(() => localStorage.getItem('fency.basemap'), null) || 'ign';
if (!basemaps[currentBase]) currentBase = layerSpecs.basemaps[0].id;
basemaps[currentBase].addTo(map);
$('basemap').value = currentBase;
$('basemap').addEventListener('change', (e) => {
  map.removeLayer(basemaps[currentBase]);
  currentBase = e.target.value;
  basemaps[currentBase].addTo(map);
  safe(() => localStorage.setItem('fency.basemap', currentBase));
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
map.createPane('reference').style.zIndex = 350;  // couche de référence : sous les dessins

// ---------------------------------------------------------------- état
const state = {
  mode: 'design',
  selected: null,           // champ sélectionné
  multi: new Set(),         // champs cochés pour une fusion
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
  fieldMulti: { color: '#e040fb', weight: 4, fillColor: '#e040fb', fillOpacity: 0.2 },
  line: { color: '#00e5ff', weight: 4 },
};

function styleDrawn() {
  const cur = currentField();
  drawn.eachLayer((l) => l.setStyle(!isField(l) ? STYLE.line : state.multi.has(l) ? STYLE.fieldMulti : l === cur ? STYLE.fieldSel : STYLE.field));
  const n = [...state.multi].filter((l) => drawn.hasLayer(l)).length;
  $('btn-merge').disabled = n < 2;
  $('btn-merge').textContent = n >= 2 ? `Fusionner (${n})` : 'Fusionner';
}

// Chaque élément dessiné porte un identifiant stable : c'est l'unité d'enregistrement
// et de synchronisation entre appareils.
const byId = new Map();   // id -> calque
let applying = false;     // vrai pendant qu'on applique des données venues du stockage
let session = null;       // session de travail (créée au démarrage)
const featureOf = (layer) => layer.toGeoJSON(8); // 8 décimales ≈ 1 mm (le guidage RTK est centimétrique)
const syncLayer = (layer) => { if (!applying) session?.putFeature(featureOf(layer)); };

function register(layer, id = uid()) {
  const kind = isField(layer) ? 'field' : 'line';
  layer.feature = { type: 'Feature', properties: { id, kind }, geometry: null };
  byId.set(id, layer);
  if (!drawn.hasLayer(layer)) drawn.addLayer(layer);
  layer.on('click', (e) => {
    if (state.mode === 'field' && kind === 'line') return pickLine(`u:${L.stamp(layer)}`);
    if (kind !== 'field') return;
    const o = e.originalEvent;
    if (state.mode === 'design' && ($('multi').checked || o?.ctrlKey || o?.shiftKey || o?.metaKey)) {
      // sélection multiple (case cochée, ou Ctrl/Maj + clic) : pour fusionner
      if (state.multi.has(layer)) state.multi.delete(layer); else state.multi.add(layer);
    } else { state.multi.clear(); state.selected = layer; }
    styleDrawn(); refresh(false);
  });
  ['pm:edit', 'pm:dragend', 'pm:vertexadded', 'pm:vertexremoved'].forEach((ev) => layer.on(ev, () => { syncLayer(layer); refresh(); }));
  styleDrawn();
}

map.on('pm:create', (e) => {
  if (cutting) { // la ligne tracée est un trait de coupe, pas une clôture
    const target = cutting, line = ringOf(e.layer);
    cutting = null; e.layer.remove();
    return cutField(target, line);
  }
  register(e.layer);
  syncLayer(e.layer);
  if (isField(e.layer)) state.selected = e.layer;
  refresh();
});
drawn.on('layerremove', (e) => {
  state.multi.delete(e.layer);
  const id = e.layer.feature?.properties?.id;
  if (id && byId.get(id) === e.layer) {
    byId.delete(id);
    if (!applying) session?.removeFeature(id);
  }
  setTimeout(() => refresh(), 0);
});

// ---------------------------------------------------------------- parcelles : créer, fusionner, couper
/** Ajoute une parcelle à partir d'un contour [[lon, lat], …] et l'enregistre. */
function addField(ring) {
  const layer = L.polygon(ring.map(([lng, lat]) => [lat, lng])).addTo(map);
  register(layer); syncLayer(layer);
  return layer;
}

$('btn-merge').addEventListener('click', async () => {
  const layers = [...state.multi].filter((l) => drawn.hasLayer(l));
  if (layers.length < 2) return;
  const { mergeParcels } = await import('./parcels.js');
  const res = mergeParcels(layers.map(ringOf));
  if (!res) return toast('Fusion impossible : ces parcelles sont séparées de plus de 5 m.');
  layers.forEach((l) => drawn.removeLayer(l));
  state.multi.clear(); $('multi').checked = false;
  state.selected = addField(res.ring);
  refresh();
  toast(res.bridged ? 'Parcelles fusionnées (espace entre elles comblé).' : 'Parcelles fusionnées.');
});

let cutting = null; // parcelle en cours de découpe (on attend le tracé du trait de coupe)
$('btn-cut').addEventListener('click', () => {
  const field = currentField();
  if (!field) return toast('Sélectionnez d\'abord une parcelle.');
  state.selected = field; styleDrawn();
  cutting = field;
  map.pm.enableDraw('Line', { snappable: true });
  toast('Tracez le trait de coupe à travers la parcelle, puis terminez sur le dernier point.');
});
map.on('pm:drawend', () => setTimeout(() => { cutting = null; }, 0)); // tracé abandonné

async function cutField(field, line) {
  const { splitParcel } = await import('./parcels.js');
  const pieces = splitParcel(ringOf(field), line);
  if (!pieces.length) return toast('Le trait doit traverser la parcelle de part en part.');
  drawn.removeLayer(field);
  const layers = pieces.map(addField);
  state.selected = layers[0];
  refresh();
  toast(`Parcelle coupée en ${pieces.length}.`);
}

// ---------------------------------------------------------------- couche de référence (WFS)
const REF_MIN_ZOOM = 14;
const ref = { spec: null, variant: null, ctrl: null, timer: null };
const refLayer = L.geoJSON(null, {
  pane: 'reference', pmIgnore: true,
  style: { color: '#ffffff', weight: 1.5, dashArray: '4 3', fillColor: '#ffffff', fillOpacity: 0.06 },
  onEachFeature: (feature, layer) => {
    layer.on('mouseover', () => layer.setStyle({ weight: 3, fillOpacity: 0.25 }));
    layer.on('mouseout', () => refLayer.resetStyle(layer));
    layer.on('click', (e) => {
      if (state.mode !== 'design' || cutting || map.pm.globalDrawModeEnabled() || map.pm.globalRemovalModeEnabled()) return;
      L.DomEvent.stopPropagation(e);
      const field = addField(outerRingAt(feature, [e.latlng.lng, e.latlng.lat]));
      state.multi.clear(); state.selected = field;
      refresh();
      const crop = feature.properties?.code_cultu ? ` (culture ${feature.properties.code_cultu})` : '';
      toast(`Parcelle créée : ${formatArea(areaLL(ringOf(field)))}${crop}.`);
    });
  },
}).addTo(map);
function fillRefSelect() {
  $('ref-layer').innerHTML = '<option value="">Aucune</option>' +
    layerSpecs.reference.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.label)}</option>`).join('');
  $('ref-layer').value = ref.spec?.id ?? '';
}
function selectReference(id) {
  ref.spec = layerSpecs.reference.find((r) => r.id === id) ?? null;
  ref.variant = null;
  $('ref-layer').value = ref.spec?.id ?? '';
  safe(() => localStorage.setItem('fency.refLayer', ref.spec?.id ?? ''));
  loadReference();
}
fillRefSelect();

async function loadReference() {
  ref.ctrl?.abort();
  const status = (t) => { $('ref-status').textContent = t; };
  if (!ref.spec) { refLayer.clearLayers(); return status(''); }
  if (map.getZoom() < REF_MIN_ZOOM) { refLayer.clearLayers(); return status('Zoomez pour afficher cette couche.'); }
  const b = map.getBounds().pad(0.15);
  const bounds = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const ctrl = ref.ctrl = new AbortController();
  status('Chargement…');
  let feats = [], error = null;
  // l'ordre des axes attendu dépend du serveur : on retient la première variante qui répond
  for (const variant of ref.variant ? [ref.variant] : BBOX_VARIANTS) {
    try {
      const res = await fetch(wfsUrl(ref.spec, bounds, { variant }), { signal: ctrl.signal });
      if (!res.ok) { error = `erreur ${res.status}`; continue; }
      feats = normalizeWfs(await res.json(), bounds);
      error = null;
      if (feats.length) { ref.variant = variant; break; }
    } catch (e) {
      if (e.name === 'AbortError') return;
      error = navigator.onLine === false ? 'pas de réseau' : 'réponse illisible ou service injoignable';
    }
  }
  if (ctrl.signal.aborted) return;
  refLayer.clearLayers();
  if (error && !feats.length) return status(`Couche indisponible (${error}).`);
  refLayer.addData({ type: 'FeatureCollection', features: feats });
  status(feats.length ? `${feats.length} polygone${feats.length > 1 ? 's' : ''} affiché${feats.length > 1 ? 's' : ''}${feats.length >= 1500 ? ' (limite atteinte : zoomez)' : ''}.` : 'Aucun polygone dans cette zone.');
}
const scheduleReference = () => { clearTimeout(ref.timer); ref.timer = setTimeout(loadReference, 350); };
map.on('moveend', scheduleReference);
$('ref-layer').addEventListener('change', (e) => selectReference(e.target.value));

// --- catalogue : ajouter des couches proposées par le serveur (autres millésimes du RPG, cadastre…)
const catalogs = new Map(); // adresse du serveur -> [{ name, title }]
function saveCustomLayers(lines) {
  customLayers = lines;
  safe(() => localStorage.setItem('fency.customLayers', JSON.stringify(lines)));
  layerSpecs = readLayers();
  if (ref.spec && !layerSpecs.reference.some((r) => r.id === ref.spec.id)) selectReference('');
  fillRefSelect(); renderMyLayers();
}
function addCatalogLayer(baseUrl, entry) {
  const line = wfsSpecLine(baseUrl, entry);
  const id = loadLayerSpecs(line).reference.at(-1).id;
  if (!layerSpecs.reference.some((r) => r.id === id)) saveCustomLayers([...customLayers, line]);
  selectReference(id);
  $('dlg-layers').close();
  toast(map.getZoom() < REF_MIN_ZOOM ? 'Couche ajoutée. Zoomez sur vos parcelles pour l\'afficher.' : 'Couche ajoutée.');
}
function renderMyLayers() {
  const box = $('cat-mine');
  box.innerHTML = customLayers.length ? '' : '<p class="hint">Aucune.</p>';
  customLayers.forEach((line, i) => {
    const spec = loadLayerSpecs(line).reference.at(-1);
    const row = document.createElement('div'); row.className = 'cat-item';
    row.innerHTML = `<div><b>${escapeHtml(spec.label)}</b><small>${escapeHtml(spec.featureTypeName)}</small></div><button class="danger">Retirer</button>`;
    row.querySelector('button').addEventListener('click', () => saveCustomLayers(customLayers.filter((_, j) => j !== i)));
    box.appendChild(row);
  });
}
async function searchLayers() {
  const input = $('cat-url').value.trim(), status = (t) => { $('cat-status').textContent = t; };
  if (!input) return;
  $('cat-results').innerHTML = '';
  const plan = catalogPlan(input);
  // { entries, baseUrl, full } : `full` devient vrai une fois le catalogue complet du serveur lu
  const cat = catalogs.get(input) ?? { entries: [], baseUrl: plan.baseUrl, full: false };
  const read = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`erreur ${res.status}`);
    const xml = await res.text(), list = parseWfsCapabilities(xml);
    if (!list.length) throw new Error('aucune couche dans la réponse');
    cat.baseUrl ??= parseWfsEndpoint(xml);
    const known = new Set(cat.entries.map((c) => c.name));
    cat.entries.push(...list.filter((c) => !known.has(c.name)));
  };
  const readFull = async () => { if (plan.full && !cat.full) { await read(plan.full); cat.full = true; } };
  let found = [];
  try {
    if (!catalogs.has(input)) {
      status('Lecture du catalogue (peut prendre quelques secondes)…');
      // catalogues thématiques d'abord (légers) ; le catalogue complet en secours
      let ok = false;
      for (const url of plan.sources) { try { await read(url); ok = true; } catch { /* source suivante */ } }
      if (!ok) await readFull();
      if (!cat.entries.length) throw new Error('aucune couche dans la réponse');
      if (!cat.baseUrl) throw new Error('adresse du service WFS introuvable dans ce catalogue');
      catalogs.set(input, cat);
    }
    found = searchCatalog(cat.entries, $('cat-query').value);
    if (!found.length && plan.full && !cat.full) { // absent du catalogue thématique : chercher dans tout le serveur
      status('Recherche dans le catalogue complet du serveur…');
      await readFull();
      found = searchCatalog(cat.entries, $('cat-query').value);
    }
  } catch (e) {
    if (!found.length) return status(`Catalogue indisponible (${e.message === 'Failed to fetch' ? 'serveur injoignable' : e.message}). Vous pouvez saisir le nom de la couche ci-dessous.`);
  }
  const baseUrl = cat.baseUrl;
  status(`${found.length} couche${found.length > 1 ? 's' : ''} trouvée${found.length > 1 ? 's' : ''} sur ${cat.entries.length}${found.length > 80 ? ' (80 premières affichées : précisez la recherche)' : ''}.`);
  for (const entry of found.slice(0, 80)) {
    const row = document.createElement('div'); row.className = 'cat-item';
    row.innerHTML = `<div><b>${escapeHtml(layerLabel(entry))}</b><small>${escapeHtml(entry.name)}</small></div><button>Ajouter</button>`;
    row.querySelector('button').addEventListener('click', () => addCatalogLayer(baseUrl, entry));
    $('cat-results').appendChild(row);
  }
}
$('btn-layers').addEventListener('click', (e) => { e.preventDefault(); $('dlg-layers').showModal(); renderMyLayers(); searchLayers(); });
$('btn-layers-close').addEventListener('click', () => $('dlg-layers').close());
$('btn-cat-search').addEventListener('click', searchLayers);
$('cat-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchLayers(); });
$('btn-cat-manual').addEventListener('click', () => {
  const name = $('cat-manual').value.trim(), input = $('cat-url').value.trim();
  const baseUrl = catalogs.get(input)?.baseUrl ?? catalogPlan(input).baseUrl;
  if (!name) return;
  if (!baseUrl) return toast('Indiquez l\'adresse du service WFS (et non celle d\'un fichier de catalogue).');
  addCatalogLayer(baseUrl, { name, title: '' });
});
{ // couche choisie la dernière fois
  const saved = safe(() => localStorage.getItem('fency.refLayer'), '');
  ref.spec = layerSpecs.reference.find((r) => r.id === saved) ?? null;
  if (ref.spec) { $('ref-layer').value = ref.spec.id; scheduleReference(); }
}

// ---------------------------------------------------------------- génération
const params = () => ({
  mode: $('gen-mode').value,
  value: parseFloat($('gen-value').value) || 0,
  angle: parseInt($('gen-angle').value, 10),
  reverse: $('gen-reverse').checked,
  perimeter: $('gen-perimeter').checked,
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
    const m = estimateMaterial(lines.map((l) => l.length), { rows: p.rows });
    $('material').innerHTML = `<table>
      <tr><td>Longueur de clôture</td><td>${formatLength(m.total)}</td></tr>
      <tr><td>Fil / ruban (${p.rows} rang${p.rows > 1 ? 's' : ''})</td><td>${formatLength(m.wire)}</td></tr></table>
      <small>Estimation indicative, hors portails et angles.</small>`;
  } else $('material').innerHTML = '';
  $('gen-angle-val').textContent = `${p.angle}°`;
  fillLineSelect();
  if (save && !applying) session?.saveMeta({ params: params(), genActive: state.genActive });
}

// ---------------------------------------------------------------- formulaire de génération
$('gen-mode').addEventListener('change', () => {
  const area = $('gen-mode').value === 'area';
  $('gen-value-label').textContent = area ? 'Surface par bande (ares, 100 a = 1 ha)' : 'Largeur (m)';
  $('gen-value').value = area ? 30 : 20;
  refresh();
});
['gen-value', 'gen-angle', 'gen-reverse', 'gen-perimeter', 'mat-rows'].forEach((id) => $(id).addEventListener('input', () => refresh()));
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
/** Ajoute des éléments GeoJSON à la carte. `keepIds` : éléments venus du stockage (identifiants conservés). */
function loadFeatures(fc, { keepIds = false } = {}) {
  const layers = [];
  L.geoJSON(fc, {
    filter: (f) => !['generated', 'perimeter'].includes(f.properties?.kind),
    onEachFeature: (f, l) => layers.push([f, l]),
  });
  let n = 0;
  for (const [f, l] of layers) {
    if (!(l instanceof L.Polyline)) continue;
    register(l, keepIds && f.properties?.id ? f.properties.id : uid());
    syncLayer(l); n++;
  }
  return n;
}

$('btn-export').addEventListener('click', () => {
  const fc = drawn.toGeoJSON(8);
  state.genLines.forEach((gl) => fc.features.push({ type: 'Feature', properties: { kind: 'generated', label: gl.label, length_m: Math.round(gl.length) }, geometry: { type: 'LineString', coordinates: gl.coords } }));
  fc.fency = { version: 1, name: session?.current?.name, params: params(), genActive: state.genActive };
  const slug = (session?.current?.name || 'plan').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plan';
  const name = `fency-${slug}-${new Date().toISOString().slice(0, 10)}.geojson`;
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
    const meta = fc.fency ?? fc.fencemapper; // « fencemapper » : anciens exports
    if (meta?.params) applyParams(meta.params);
    state.genActive = !!meta?.genActive;
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
  $('mat-rows').value = p.rows ?? 1;
}

// ---------------------------------------------------------------- ma position
$('btn-locate').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Géolocalisation indisponible.');
  navigator.geolocation.getCurrentPosition(
    (p) => map.setView([p.coords.latitude, p.coords.longitude], 17),
    () => toast('Position refusée ou indisponible.'), { enableHighAccuracy: true, timeout: 15000 });
});

// ================================================================ MODE TERRAIN
// Guidage en deux étapes : 1) rejoindre le départ de la clôture (flèche + distance) ;
// 2) poser la clôture en restant sur la ligne (vue en perspective + quadrillage).
const gps = {
  watch: null, wake: null, on: false, last: null, accuracy: 0, lines: [],
  target: 'auto', autoId: null, lineId: null, reversed: false, autoStart: true, // départ = extrémité la plus proche, sauf choix manuel
  prep: null, loc: null, start: null, phase: null,
  compass: null, heading: null, course: null, // { deg, t } : boussole, et cap de déplacement donné par le GPS
};

function fillLineSelect() {
  const sel = $('target-line');
  const prev = gps.target;
  gps.lines = allLines();
  sel.innerHTML = `<option value="auto">Ligne la plus proche (auto)</option>` +
    gps.lines.map((l) => `<option value="${l.id}">${l.label} · ${formatLength(l.length)}</option>`).join('');
  sel.value = gps.lines.some((l) => l.id === prev) || prev === 'auto' ? prev : 'auto';
  gps.target = sel.value;
}
/** Repart de zéro sur la ligne à suivre (nouvelle ligne, nouveau sens). */
function resetGuidance({ autoStart = true } = {}) { gps.lineId = null; gps.phase = null; gps.autoStart = autoStart; }
function pickLine(id) { gps.target = id; $('target-line').value = id; resetGuidance(); if (gps.last) update(); else drawTarget(); }
$('target-line').addEventListener('change', (e) => pickLine(e.target.value));
$('btn-reverse-line').addEventListener('click', () => {
  gps.reversed = !gps.reversed; resetGuidance({ autoStart: false });
  update(); toast('Départ à l\'autre extrémité de la clôture.');
});
$('btn-phase').addEventListener('click', () => { gps.phase = gps.phase === 'approach' ? 'lay' : 'approach'; render(); });

function chooseLine(ll) {
  const lines = gps.lines;
  if (!lines.length) return null;
  if (gps.target !== 'auto') return lines.find((l) => l.id === gps.target) || null;
  const cur = lines.find((l) => l.id === gps.autoId);
  const dist = (l) => locate(prepareLine(l.coords), ll).dist;
  if (cur && dist(cur) < 15) return cur;
  let best = lines[0], bd = Infinity;
  for (const l of lines) { const d = dist(l); if (d < bd) { bd = d; best = l; } }
  gps.autoId = best.id;
  return best;
}

const fmt1 = (m) => (m < 10 ? m.toFixed(1) : Math.round(m)).toString().replace('.', ',');
// repère du quad sur la carte : une flèche quand le cap est connu, un point sinon
const ME_ICON = '<svg id="me-arrow" viewBox="-16 -16 32 32" width="32" height="32">'
  + '<path class="me-dir" d="M0,-14 L10,9 L0,3 L-10,9 Z" fill="#1565c0" stroke="#fff" stroke-width="2.5" stroke-linejoin="round" />'
  + '<circle class="me-dot" r="7" fill="#1565c0" stroke="#fff" stroke-width="3" /></svg>';
const me = L.marker([0, 0], { interactive: false, zIndexOffset: 1000, icon: L.divIcon({ className: 'quad-icon', html: ME_ICON, iconSize: [32, 32], iconAnchor: [16, 16] }) });
/** Fait tourner un élément vers un angle par le plus court chemin (pas de grand tour en repassant par le nord). */
const turned = new WeakMap();
function rotateTo(el, deg) {
  const prev = turned.get(el) ?? 0, next = prev + angleDiff(deg, prev);
  turned.set(el, next); el.style.transform = `rotate(${next}deg)`;
}

/** Sur la carte : la clôture à suivre, son départ (vert) et son arrivée (rouge). */
function drawTarget() {
  guideLayer.clearLayers();
  const line = gps.target === 'auto' ? gps.lines.find((l) => l.id === gps.autoId) : gps.lines.find((l) => l.id === gps.target);
  if (!line) return;
  const coords = gps.reversed ? [...line.coords].reverse() : line.coords;
  L.polyline(coords.map(([lng, lat]) => [lat, lng]), { color: '#fff', weight: 7, opacity: 0.9, interactive: false }).addTo(guideLayer);
  const dot = ([lng, lat], color) => L.circleMarker([lat, lng], { radius: 8, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1, interactive: false }).addTo(guideLayer);
  dot(coords[0], '#2e7d32'); dot(coords.at(-1), '#c62828');
  if (gps.last) me.addTo(guideLayer);
}

/** Cap du quad : boussole si elle répond, sinon direction de déplacement donnée par le GPS. */
function currentHeading() {
  const now = Date.now();
  if (gps.heading && now - gps.heading.t < 3000) return { deg: gps.heading.deg, source: 'boussole' };
  if (gps.course && now - gps.course.t < 5000) return { deg: gps.course.deg, source: 'déplacement' };
  return null;
}

/** Recalcule la position par rapport à la clôture et l'étape en cours. */
function update() {
  const ll = gps.last; if (!ll) return;
  const line = chooseLine(ll);
  if (!line) {
    gps.prep = null; $('approach').hidden = true; $('lay').hidden = true; $('btn-phase').hidden = true;
    $('guide-step').textContent = 'Aucune clôture à suivre : dessinez ou générez-en.';
    return;
  }
  if (gps.lineId !== line.id) {
    if (gps.autoStart) gps.reversed = nearerEndIsLast(line.coords, ll);
    gps.lineId = line.id; gps.phase = null;
    gps.prep = prepareLine(gps.reversed ? [...line.coords].reverse() : line.coords);
    drawTarget();
  }
  gps.loc = locate(gps.prep, ll);
  gps.start = toStart(gps.prep, ll);
  gps.phase = nextPhase(gps.phase, { distStart: gps.start.dist, cross: gps.loc.cross, along: gps.loc.along, length: gps.prep.length, accuracy: gps.accuracy });
  render();
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  if (!gps.prep || !gps.last || !gps.loc) return;
  const heading = currentHeading(), { loc, start, prep } = gps;
  $('st-heading').textContent = heading ? `${Math.round(heading.deg)}°` : '—';
  $('st-heading-label').textContent = heading ? `cap (${heading.source})` : 'cap indisponible';
  const arrow = document.getElementById('me-arrow');
  if (arrow) { arrow.classList.toggle('has-heading', !!heading); if (heading) rotateTo(arrow, heading.deg); }

  const approach = gps.phase === 'approach';
  $('approach').hidden = !approach; $('lay').hidden = approach;
  $('btn-phase').hidden = false;
  $('btn-phase').textContent = approach ? 'Passer à la pose' : 'Revenir au départ';

  if (approach) {
    $('guide-step').textContent = 'Étape 1 · Rejoindre le départ';
    // flèche vers le départ, relative à l'orientation du téléphone (au nord si la boussole manque)
    rotateTo($('approach-arrow'), start.bearing - (heading?.deg ?? 0));
    $('approach-dist').textContent = `${fmt1(start.dist)} m`;
    $('approach-sub').textContent = heading ? 'jusqu\'au départ de la clôture' : 'Boussole indisponible : flèche par rapport au nord';
    $('st-left').textContent = formatLength(prep.length); $('st-left-label').textContent = 'longueur à poser';
    return;
  }

  const done = gps.phase === 'done', abs = Math.abs(loc.cross);
  $('guide-step').textContent = done ? 'Clôture terminée ✔' : 'Étape 2 · Pose de la clôture';
  const level = abs < 0.3 ? 'ok' : abs < 1 ? 'warn' : 'bad';
  // Où est la clôture par rapport à l'avant du quad ? (cross > 0 : on est à droite de la ligne,
  // donc elle est à gauche de son propre sens ; on rapporte cette direction au cap réel.)
  const lineDir = bearingAt(prep, loc.along);
  const rel = angleDiff(lineDir + (loc.cross > 0 ? -90 : 90), heading?.deg ?? lineDir);
  const sector = ((Math.round(rel / 45) % 8) + 8) % 8;
  $('steer').textContent = abs < 0.1 ? '✔ sur la ligne' : `${['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'][sector]} ${fmt1(abs)} m`;
  $('steer').className = `steer small ${level}`;
  $('steer-sub').textContent = abs < 0.1 ? '' : `La clôture est ${['devant', 'devant à droite', 'à droite', 'derrière à droite', 'derrière', 'derrière à gauche', 'à gauche', 'devant à gauche'][sector]}`;
  $('st-left').textContent = formatLength(Math.max(0, prep.length - loc.along)); $('st-left-label').textContent = 'reste à poser';

  // vue en perspective : orientée selon le cap ; sans cap connu, dans l'axe de la clôture
  const canvas = $('persp'), dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const lineBearing = bearingAt(prep, loc.along), view = heading?.deg ?? lineBearing;
  const [ux, uy] = prep.proj.toXY(gps.last);
  const cam = (xy) => toCameraFrame([xy[0] - ux, xy[1] - uy], view);
  const b = (lineBearing * Math.PI) / 180;
  const visible = drawScene(ctx, makeCamera({ width: w, height: h }), {
    fence: prep.pts.map(cam),
    origin: cam(prep.proj.toXY(pointAt(prep, loc.along))),
    dir: toCameraFrame([Math.sin(b), Math.cos(b)], view),
    along: loc.along, level,
  });
  if (!visible) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, h / 2 - 22, w, 44);
    ctx.fillStyle = '#fff'; ctx.font = '600 16px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Clôture hors de vue : tournez-vous vers elle', w / 2, h / 2);
  }
}

function onPos(pos) {
  const c = pos.coords;
  gps.last = [c.longitude, c.latitude];
  gps.accuracy = c.accuracy ?? 0;
  if (c.heading != null && !Number.isNaN(c.heading) && (c.speed ?? 0) > 0.5) gps.course = { deg: c.heading, t: Date.now() };
  const ll = [c.latitude, c.longitude];
  me.setLatLng(ll).addTo(guideLayer);
  const acc = c.accuracy == null ? '—' : c.accuracy < 1 ? `±${Math.round(c.accuracy * 100)} cm` : `±${fmt1(c.accuracy)} m`;
  $('st-acc').textContent = acc;
  $('st-acc').className = pos.quality ? `q-${pos.quality}` : '';
  $('st-acc-label').textContent = pos.qualityLabel || 'précision GPS';
  if (!gps.centered) { map.setView(ll, Math.max(map.getZoom(), 19)); gps.centered = true; }
  else if (!map.getBounds().pad(-0.25).contains(ll)) map.panTo(ll);
  update();
}

/** Boussole du téléphone : à lancer sur une action de l'utilisateur (autorisation sur iPhone). */
async function startCompassOnce() {
  if (gps.compass) return;
  gps.compass = await startCompass((deg) => { gps.heading = { deg, t: Date.now() }; scheduleRender(); });
}

async function startGps() {
  startCompassOnce();
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
  gps.compass?.stop(); gps.compass = null; gps.heading = null;
  setGpsButton(false);
}
function setGpsButton(on) { gps.on = on; $('btn-gps').textContent = on ? '■ Arrêter le GPS' : '▶ Démarrer le GPS'; }
$('btn-gps').addEventListener('click', () => (gps.on ? stopGps() : startGps()));
map.on('click', (e) => { if (state.mode === 'field' && $('sim').checked) { gps.centered = true; onPos({ coords: { latitude: e.latlng.lat, longitude: e.latlng.lng, accuracy: 2, heading: null, speed: 0 } }); } });
document.addEventListener('visibilitychange', async () => { if (!document.hidden && gps.on && gps.watch != null) safe(async () => { gps.wake = await navigator.wakeLock?.request('screen'); }); });
window.addEventListener('resize', scheduleRender);

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
  if (design) { map.pm.addControls(GEOMAN_CONTROLS); guideLayer.clearLayers(); }
  else { map.pm.removeControls(); fillLineSelect(); resetGuidance(); drawTarget(); if (gps.last) update(); }
  setTimeout(() => map.invalidateSize(), 50);
}
$('tab-design').addEventListener('click', () => setMode('design'));
$('tab-field').addEventListener('click', () => setMode('field'));

// ---------------------------------------------------------------- plans, comptes, partage
const sessionUi = {
  applyPlan(meta, features) {
    applying = true;
    try {
      drawn.clearLayers(); byId.clear(); state.selected = null;
      applyParams(meta.params); state.genActive = !!meta.genActive;
      loadFeatures({ type: 'FeatureCollection', features }, { keepIds: true });
    } finally { applying = false; }
    refresh(false); showPlanName();
    if (drawn.getLayers().length) map.fitBounds(drawn.getBounds(), { padding: [30, 30], maxZoom: 18 });
  },
  applyMeta(meta) {
    applying = true;
    try { applyParams(meta.params); state.genActive = !!meta.genActive; } finally { applying = false; }
    refresh(false); showPlanName();
  },
  upsertFeature(feature) {
    const id = feature.properties.id, old = byId.get(id), wasSelected = old && state.selected === old;
    applying = true;
    try {
      if (old) drawn.removeLayer(old);
      byId.delete(id);
      loadFeatures({ type: 'FeatureCollection', features: [feature] }, { keepIds: true });
    } finally { applying = false; }
    if (wasSelected) state.selected = byId.get(id);
    refresh(false);
  },
  removeFeature(id) {
    const layer = byId.get(id);
    if (!layer) return;
    applying = true;
    try { byId.delete(id); drawn.removeLayer(layer); } finally { applying = false; }
    refresh(false);
  },
  planGone() { toast('Ce plan a été supprimé.'); openDefaultPlan(); },
  status(st) {
    const el = $('plan-sync');
    el.textContent = { saving: 'Enregistrement…', saved: 'Enregistré', error: 'Non enregistré' }[st] ?? '';
    el.className = `badge ${st}`;
  },
};

let backend = null;
const showPlanName = () => { $('plan-name').textContent = session?.current?.name ?? 'Aucun plan ouvert'; };
const planLink = (id) => `${android ? (import.meta.env.VITE_FENCY_PUBLIC_URL || '') : location.origin + location.pathname}?plan=${id}`;
const fmtDate = (ms) => new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

/** Ouvre le plan du lien, sinon le dernier utilisé, sinon le plus récent, sinon en crée un. */
async function openDefaultPlan() {
  const url = new URL(location.href), shared = url.searchParams.get('plan');
  if (shared) {
    url.searchParams.delete('plan'); history.replaceState(null, '', url);
    if (await session.open(shared, { join: true })) return;
    toast('Plan partagé introuvable ou inaccessible.');
  }
  const last = safe(() => localStorage.getItem(`fency.lastPlan.${backend.name}`), null);
  if (last && await session.open(last)) return;
  const plans = await session.list();
  if (plans.length && await session.open(plans[0].id)) return;
  // premier lancement : reprendre le plan unique des anciennes versions, s'il existe
  const legacy = backend.name === 'local' ? safe(() => JSON.parse(localStorage.getItem(LEGACY_KEY)), null) : null;
  const features = (legacy?.features?.features ?? []).map((f) => ({ ...f, properties: { ...f.properties, id: uid() } }));
  await session.create('Mon plan', { features, params: legacy?.params ?? params(), genActive: !!legacy?.genActive });
}

async function renderPlans() {
  const box = $('plans-list');
  box.textContent = 'Chargement…';
  let plans;
  try { plans = await session.list(); } catch (e) { box.textContent = 'Liste indisponible : ' + (e.message ?? e); return; }
  box.innerHTML = plans.length ? '' : '<p class="hint">Aucun plan.</p>';
  for (const p of plans) {
    const row = document.createElement('div');
    row.className = 'plan-item' + (p.id === session.current?.id ? ' current' : '');
    row.innerHTML = `<div><b>${escapeHtml(p.name)}</b><small>${fmtDate(p.updatedAt)}${p.memberIds.length > 1 ? ` · ${p.memberIds.length} membres` : ''}</small></div>
      <span><button data-act="open">Ouvrir</button><button data-act="rename" title="Renommer">✎</button><button data-act="delete" class="danger" title="Supprimer">🗑</button></span>`;
    row.addEventListener('click', async (e) => {
      const act = e.target.dataset?.act;
      if (act === 'open') { await session.open(p.id); $('dlg-plans').close(); }
      if (act === 'rename') {
        const name = prompt('Nom du plan :', p.name)?.trim();
        if (!name) return;
        if (p.id === session.current?.id) { session.saveMeta({ name }); await session.flush(); showPlanName(); }
        else await backend.store.saveMeta(p.id, { name });
        renderPlans();
      }
      if (act === 'delete') {
        if (!confirm(`Supprimer définitivement « ${p.name} » ?`)) return;
        const wasCurrent = p.id === session.current?.id;
        try { await session.remove(p.id); } catch { return toast('Suppression refusée (réservée au propriétaire).'); }
        if (wasCurrent) await openDefaultPlan();
        renderPlans();
      }
    });
    box.appendChild(row);
  }
}

$('btn-plans').addEventListener('click', () => { if (!session) return; $('dlg-plans').showModal(); renderPlans(); });
$('btn-plans-close').addEventListener('click', () => $('dlg-plans').close());
$('btn-plan-new').addEventListener('click', async () => {
  const name = prompt('Nom du nouveau plan :', 'Nouveau plan')?.trim();
  if (!name) return;
  await session.create(name, { params: params() });
  $('dlg-plans').close();
});
$('btn-plan-join').addEventListener('click', async () => {
  const input = prompt('Collez le lien ou le code du plan partagé :')?.trim();
  if (!input) return;
  const id = input.includes('plan=') ? new URL(input, location.href).searchParams.get('plan') : input;
  if (id && await session.open(id, { join: true })) $('dlg-plans').close();
  else toast('Plan introuvable ou inaccessible.');
});
$('btn-share').addEventListener('click', async () => {
  if (!session?.current) return;
  await session.flush();
  const link = planLink(session.current.id);
  try { await navigator.clipboard.writeText(link); toast('Lien de partage copié. Toute personne connectée qui l\'ouvre peut modifier ce plan.'); }
  catch { prompt('Lien de partage (à copier) :', link); }
});

// --- compte (seulement si l'hébergement gère des comptes)
function showAccount(user) {
  $('btn-account').textContent = user ? `👤 ${user.name}` : 'Se connecter';
}
$('btn-account').addEventListener('click', async () => {
  if (!backend.auth.user) return $('dlg-auth').showModal();
  if (confirm(`Se déconnecter de ${backend.auth.user.name} ?`)) { await session.flush(); await backend.auth.signOut(); }
});
$('btn-auth-close').addEventListener('click', () => $('dlg-auth').close());
async function signIn(opts) {
  $('auth-error').textContent = '';
  try { await backend.auth.signIn(opts); $('dlg-auth').close(); }
  catch (e) {
    const { authErrorMessage } = await import('./backends/firebase/auth.js');
    $('auth-error').textContent = authErrorMessage(e);
  }
}
$('btn-auth-google').addEventListener('click', () => signIn({ method: 'google' }));
$('btn-auth-login').addEventListener('click', () => signIn({ method: 'password', email: $('auth-email').value.trim(), password: $('auth-pass').value }));
$('btn-auth-create').addEventListener('click', () => signIn({ method: 'password', email: $('auth-email').value.trim(), password: $('auth-pass').value, create: true }));

// ---------------------------------------------------------------- démarrage
async function boot() {
  backend = await createBackend({ ...readConfig(import.meta.env), webview: !!android });
  if (backend.fallback) toast('Mode en ligne indisponible : les plans restent sur cet appareil.');
  session = createSession({
    store: backend.store, ui: sessionUi,
    remember: {
      get: () => safe(() => localStorage.getItem(`fency.lastPlan.${backend.name}`), null),
      set: (id) => safe(() => (id ? localStorage.setItem(`fency.lastPlan.${backend.name}`, id) : localStorage.removeItem(`fency.lastPlan.${backend.name}`))),
    },
  });
  const { auth, store } = backend;
  $('btn-share').hidden = !store.capabilities.sharing;
  $('btn-plan-join').hidden = !store.capabilities.sharing;
  $('btn-account').hidden = !auth.capabilities.signIn;
  $('btn-auth-google').hidden = !auth.capabilities.methods.includes('google');
  $('plan-backend').textContent = store.capabilities.sharing
    ? 'Plans en ligne : synchronisés et partageables.'
    : 'Plans enregistrés sur cet appareil uniquement.';

  await auth.ready;
  let lastUserId = Symbol('inconnu'); // ni un identifiant, ni « déconnecté » (null)
  auth.onChange(async (user) => {
    const id = user?.id ?? null;
    if (id === lastUserId) return;
    lastUserId = id;
    showAccount(user);
    if (user) await openDefaultPlan().catch((e) => { console.warn(e); toast('Impossible d\'ouvrir les plans.'); });
    else {
      session.close();
      applying = true; try { drawn.clearLayers(); byId.clear(); } finally { applying = false; }
      refresh(false); showPlanName();
      if (auth.capabilities.signIn) $('dlg-auth').showModal();
    }
  });
}
// ne rien perdre si l'on quitte l'application juste après une modification
document.addEventListener('visibilitychange', () => { if (document.hidden) session?.flush(); });

refresh(false);
const ready = boot().catch((e) => { console.error(e); toast('Erreur au démarrage du stockage.'); });
window.__fm = { setHeading: (deg) => { gps.heading = deg == null ? null : { deg, t: Infinity }; render(); }, map, drawn, refLayer, state, gps, register, refresh, onPos, setMode, L, ready, syncLayer, get session() { return session; }, get backend() { return backend; } }; // utile pour les tests

if (import.meta.env.PROD && !android && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
