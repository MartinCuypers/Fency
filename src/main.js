import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import './style.css';
import { areaLL, lengthLL, longestEdgeBearing, formatArea, formatLength } from './geo.js';
import { generateStrips } from './generate.js';
import { prepareLine, locate, pointAt, toStart, bearingAt, nextPhase, nearerEndIsLast } from './guidance.js';
import { startCompass, angleDiff } from './compass.js';
import { makeCamera, toCameraFrame, drawScene } from './perspective.js';
import { createBackend, readConfig } from './backends/index.js';
import { uid } from './backends/types.js';
import { createSession } from './session.js';
import { createToolbar } from './toolbar.js';
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
const map = L.map('map', { zoomControl: false, maxZoom: 21 }).setView([46.6, 2.4], 6);

// couches ajoutées par l'utilisateur depuis le catalogue d'un serveur (mémorisées sur l'appareil)
let customLayers = safe(() => JSON.parse(localStorage.getItem('fency.customLayers')), null) ?? [];
const readLayers = () => loadLayerSpecs([import.meta.env.VITE_FENCY_LAYERS, ...customLayers].filter(Boolean).join('|'));
let layerSpecs = readLayers();
const basemaps = Object.fromEntries(layerSpecs.basemaps.map((spec) =>
  [spec.id, L.tileLayer(tileUrl(spec), { maxZoom: 21, crossOrigin: true, ...tileOptions(spec) })]));
let currentBase = safe(() => localStorage.getItem('fency.basemap'), null) || 'ign';
if (!basemaps[currentBase]) currentBase = layerSpecs.basemaps[0].id;
basemaps[currentBase].addTo(map);
function setBasemap(id) {
  if (!basemaps[id] || id === currentBase) return;
  map.removeLayer(basemaps[currentBase]);
  currentBase = id;
  basemaps[currentBase].addTo(map);
  safe(() => localStorage.setItem('fency.basemap', currentBase));
}
function renderBasemaps() {
  const box = $('basemap-list');
  box.innerHTML = '';
  for (const b of layerSpecs.basemaps) {
    const btn = document.createElement('button');
    btn.className = 'choice' + (b.id === currentBase ? ' current' : '');
    btn.textContent = b.label;
    btn.addEventListener('click', () => { setBasemap(b.id); $('dlg-basemap').close(); });
    box.appendChild(btn);
  }
}

// fenêtres : boutons « Fermer », et clic à côté de la fenêtre
document.querySelectorAll('dialog').forEach((dlg) => {
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
});
/** Ferme les fenêtres ouvertes puis ouvre celle demandée. */
const openDialog = (id) => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); $(id).showModal(); };

map.pm.setLang('fr');
map.pm.setGlobalOptions({ snappable: true, snapDistance: 15 });

const drawn = L.featureGroup().addTo(map);      // dessins de l'utilisateur (champs, clôtures)
const generated = L.featureGroup().addTo(map);  // repères virtuels (recalculés ; Conception seulement)
const guideLayer = L.featureGroup().addTo(map); // ligne cible, piquets, position
map.createPane('reference').style.zIndex = 350;  // couche de référence : sous les dessins

// ---------------------------------------------------------------- état
const state = {
  mode: 'design',
  selected: null,           // dernière parcelle sélectionnée (sert à la génération)
  sel: new Set(),           // objets sélectionnés (tous du même type : parcelles ou clôtures)
  selMarks: false,          // repères virtuels sélectionnés (ils forment un tout)
  genActive: false,
  genLines: [],             // repères virtuels {coords,length,label}
  strips: [],
};
let tool = null;     // outil actif de la barre (un seul à la fois), voir setTool
let toolbar = null;  // barre d'outils de la carte (src/toolbar.js)

const toast = (msg) => {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
};

const ringOf = (layer) => {
  let ll = layer.getLatLngs();
  while (Array.isArray(ll[0])) ll = ll[0];
  return ll.map((p) => [p.lng, p.lat]);
};
// Types d'objets dessinés : parcelle ('field'), obstacle (polygone exclu des repères) et clôture ('line').
const KINDS = ['field', 'obstacle', 'line'];
const isPolygon = (l) => l instanceof L.Polygon;
const kindOf = (l) => l.feature?.properties?.kind ?? (isPolygon(l) ? 'field' : 'line');
const isField = (l) => kindOf(l) === 'field';
const isObstacle = (l) => kindOf(l) === 'obstacle';
const nameOf = (l) => l.feature?.properties?.name ?? '';
const fields = () => drawn.getLayers().filter(isField);
const obstacles = () => drawn.getLayers().filter(isObstacle);
const userLines = () => drawn.getLayers().filter((l) => kindOf(l) === 'line');
const currentField = () => (state.selected && drawn.hasLayer(state.selected) ? state.selected : fields().slice(-1)[0] || null);
const selected = () => [...state.sel].filter((l) => drawn.hasLayer(l));
/** Type de la sélection : 'field', 'line', 'marks' ou null. */
const selKind = () => (state.selMarks ? 'marks' : selected()[0] ? kindOf(selected()[0]) : null);

const STYLE = {
  field: { color: '#ffeb3b', weight: 3, fillColor: '#ffeb3b', fillOpacity: 0.08 },
  fieldSel: { color: '#ff9800', weight: 4, fillColor: '#ff9800', fillOpacity: 0.12 },
  obstacle: { color: '#d84315', weight: 2, dashArray: '6 4', fillColor: '#3e2723', fillOpacity: 0.45 },
  obstacleSel: { color: '#ff9800', weight: 4, dashArray: null, fillColor: '#3e2723', fillOpacity: 0.55 },
  line: { color: '#00e5ff', weight: 4 },
  lineSel: { color: '#2979ff', weight: 7 },
};

function styleDrawn() {
  drawn.eachLayer((l) => { const k = kindOf(l); l.setStyle(STYLE[state.sel.has(l) ? `${k}Sel` : k]); });
  generated.eachLayer((l) => l.setStyle({ weight: state.selMarks ? 6 : l.options.baseWeight }));
  updateToolbar();
}

// Chaque élément dessiné porte un identifiant stable : c'est l'unité d'enregistrement
// et de synchronisation entre appareils.
const byId = new Map();   // id -> calque
let applying = false;     // vrai pendant qu'on applique des données venues du stockage
let session = null;       // session de travail (créée au démarrage)
const featureOf = (layer) => layer.toGeoJSON(8); // 8 décimales ≈ 1 mm (le guidage RTK est centimétrique)
const syncLayer = (layer) => { if (!applying) session?.putFeature(featureOf(layer)); };

/**
 * Enregistre un objet dessiné. `props` : propriétés venues du stockage, d'un import ou de l'outil
 * (type et nom ; le type par défaut se déduit de la forme : polygone = parcelle, ligne = clôture).
 */
function register(layer, id = uid(), props = {}) {
  const shape = isPolygon(layer) ? 'polygon' : 'line';
  const kind = KINDS.includes(props.kind) && (props.kind === 'line') === (shape === 'line') ? props.kind : (shape === 'polygon' ? 'field' : 'line');
  layer.feature = { type: 'Feature', properties: { id, kind, ...(props.name ? { name: String(props.name) } : {}) }, geometry: null };
  byId.set(id, layer);
  if (!drawn.hasLayer(layer)) drawn.addLayer(layer);
  // en Conception, la sélection passe par un clic sur la carte (voir pickAt)
  layer.on('click', () => { if (state.mode === 'field' && kind === 'line') pickLine(`u:${L.stamp(layer)}`); });
  ['pm:edit', 'pm:dragend', 'pm:vertexadded', 'pm:vertexremoved'].forEach((ev) => layer.on(ev, () => { syncLayer(layer); refresh(); }));
  applyTool(layer, tool);
  styleDrawn();
}

map.on('pm:create', (e) => {
  if (cutting) { // la ligne tracée est un trait de coupe, pas une clôture
    const target = cutting, line = ringOf(e.layer);
    cutting = null; e.layer.remove();
    return cutField(target, line);
  }
  register(e.layer, uid(), { kind: tool === 'obstacle' ? 'obstacle' : undefined });
  syncLayer(e.layer);
  select([e.layer]);
  refresh();
});
drawn.on('layerremove', (e) => {
  state.sel.delete(e.layer);
  const id = e.layer.feature?.properties?.id;
  if (id && byId.get(id) === e.layer) {
    byId.delete(id);
    if (!applying) session?.removeFeature(id);
  }
  setTimeout(() => refresh(), 0);
});

// ---------------------------------------------------------------- parcelles : créer, fusionner, couper
/** Ajoute une parcelle à partir d'un contour [[lon, lat], …] et l'enregistre. */
function addField(ring, props = {}) {
  const layer = L.polygon(ring.map(([lng, lat]) => [lat, lng])).addTo(map);
  register(layer, uid(), props); syncLayer(layer);
  return layer;
}

async function mergeSelected() {
  const layers = selected().filter(isField);
  if (layers.length < 2) return;
  const { mergeParcels } = await import('./parcels.js');
  const res = mergeParcels(layers.map(ringOf));
  if (!res) return toast('Fusion impossible : ces parcelles sont séparées de plus de 5 m.');
  setTool(null);
  layers.forEach((l) => drawn.removeLayer(l));
  // la parcelle fusionnée garde le premier nom trouvé ; « X (1) » + « X (2) » redonnent « X »
  const names = layers.map(nameOf).filter(Boolean), bases = new Set(names.map((n) => n.replace(/ \(\d+\)$/, '')));
  const name = bases.size === 1 && names.length === layers.length ? [...bases][0] : names[0];
  select([addField(res.ring, { name })]);
  refresh();
  toast(res.bridged ? 'Parcelles fusionnées (espace entre elles comblé).' : 'Parcelles fusionnées.');
}

let cutting = null; // parcelle en cours de découpe (on attend le tracé du trait de coupe)

async function cutField(field, line) {
  const { splitParcel } = await import('./parcels.js');
  const pieces = splitParcel(ringOf(field), line);
  if (!pieces.length) return toast('Le trait doit traverser la parcelle de part en part.');
  drawn.removeLayer(field);
  const name = nameOf(field); // les morceaux reprennent le nom, numéroté
  const layers = pieces.map((ring, i) => addField(ring, { name: name && `${name} (${i + 1})` }));
  select([layers[0]]);
  refresh();
  toast(`Parcelle coupée en ${pieces.length}.`);
}

// ---------------------------------------------------------------- sélection (Conception)
// Par défaut, un clic sur la carte sélectionne l'objet visé, quel que soit son type. S'il y en a
// plusieurs sous le clic : d'abord un objet ponctuel, puis une ligne, puis la plus petite surface.
// Ctrl/Maj + clic ajoute à la sélection (objets du même type).
const HIT_PX = 14; // tolérance de clic autour des points et des lignes (en pixels écran)

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function distToLine(pt, layer) {
  const pts = ringOf(layer).map(([lng, lat]) => map.latLngToContainerPoint([lat, lng]));
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSegment(pt, pts[i - 1], pts[i]));
  return d;
}
function insideRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Objet visé par un clic : { layer } pour un objet dessiné, { marks: true } pour les repères, ou null. */
function hitTest(latlng) {
  const pt = map.latLngToContainerPoint(latlng);
  // 1. objets ponctuels (électrificateurs, à venir)
  const points = drawn.getLayers().filter((l) => l instanceof L.Marker)
    .map((l) => ({ l, d: pt.distanceTo(map.latLngToContainerPoint(l.getLatLng())) })).filter((c) => c.d <= HIT_PX);
  if (points.length) return { layer: points.sort((a, b) => a.d - b.d)[0].l };
  // 2. lignes : clôtures dessinées, puis repères virtuels
  const lines = userLines().map((l) => ({ l, d: distToLine(pt, l) })).filter((c) => c.d <= HIT_PX);
  if (lines.length) return { layer: lines.sort((a, b) => a.d - b.d)[0].l };
  if (generated.getLayers().some((l) => distToLine(pt, l) <= HIT_PX)) return { marks: true };
  // 3. surfaces (parcelles, obstacles) : la plus petite qui contient le point
  const ll = [latlng.lng, latlng.lat];
  const surf = drawn.getLayers().filter(isPolygon).filter((l) => insideRing(ll, ringOf(l))).map((l) => ({ l, a: areaLL(ringOf(l)) }));
  if (surf.length) return { layer: surf.sort((a, b) => a.a - b.a)[0].l };
  return null;
}

/** Remplace la sélection. */
function select(layers = [], { marks = false } = {}) {
  state.sel = new Set(layers);
  state.selMarks = marks;
  const f = layers.find(isField);
  if (f) state.selected = f;
  if (tool && !TOOL_KEEPS_SELECTION.has(tool)) setTool(null);
  refresh(false);
}

map.on('click', (e) => {
  if (state.mode !== 'design') return;
  const hit = hitTest(e.latlng), o = e.originalEvent;
  if (tool === 'merge') { // on complète la sélection de parcelles à fusionner
    if (hit?.layer && isField(hit.layer)) {
      if (state.sel.has(hit.layer)) state.sel.delete(hit.layer); else state.sel.add(hit.layer);
      state.selected = hit.layer; refresh(false);
    }
    return;
  }
  if (/^(edit|drag):/.test(tool)) {
    if (!hit) select([]); // clic dans le vide : fin de la modification
    return;
  }
  if (tool) return; // dessin, découpe, couche de référence : la carte appartient à l'outil
  if (!hit) return select([]);
  if (hit.marks) return select([], { marks: true });
  if ((o?.ctrlKey || o?.shiftKey || o?.metaKey) && selKind() === kindOf(hit.layer)) {
    const next = new Set(state.sel);
    if (next.has(hit.layer)) next.delete(hit.layer); else next.add(hit.layer);
    return select([...next]);
  }
  select([hit.layer]);
});

function deleteSelection() {
  const layers = selected();
  if (!layers.length) return;
  select([]);
  layers.forEach((l) => drawn.removeLayer(l));
  toast(layers.length > 1 ? `${layers.length} objets supprimés.` : 'Objet supprimé.');
}

// ---------------------------------------------------------------- barre d'outils (Conception)
// Un seul outil actif à la fois. Modifier / Déplacer / Supprimer agissent sur la sélection :
// on active Geoman objet par objet plutôt qu'en mode global.
const DRAW_TOOLS = { polygon: 'Polygon', obstacle: 'Polygon', line: 'Line', cut: 'Line' };
const TOOL_KEEPS_SELECTION = new Set(['merge']);
// outils pendant lesquels les repères virtuels attirent le curseur (accrochage Geoman)
const SNAP_TO_MARKS = new Set(['line', 'edit:line']);
const TOOL_HINTS = {
  polygon: 'Cliquez les sommets de la parcelle, puis le premier point pour la fermer.',
  obstacle: 'Cliquez les sommets de l\'obstacle, puis le premier point pour le fermer.',
  line: 'Cliquez les points de la clôture, puis à nouveau le dernier point pour terminer.',
  cut: 'Tracez le trait de coupe à travers la parcelle, puis terminez sur le dernier point.',
  merge: 'Cliquez les autres parcelles à fusionner, puis à nouveau sur Fusionner.',
  reference: 'Cliquez un polygone de la couche de référence pour créer une parcelle.',
  'edit:field': 'Déplacez les sommets de la parcelle.',
  'edit:line': 'Déplacez les points de la clôture.',
  'drag:field': 'Faites glisser la parcelle pour la déplacer.',
  'drag:line': 'Faites glisser la clôture pour la déplacer.',
  'edit:obstacle': 'Déplacez les sommets de l\'obstacle.',
  'drag:obstacle': 'Faites glisser l\'obstacle pour le déplacer.',
};

/** Met un objet dans l'état voulu par l'outil (édition des sommets, déplacement) : seulement s'il est sélectionné. */
function applyTool(layer, t) {
  if (!layer.pm) return;
  const kind = kindOf(layer), mine = state.sel.has(layer);
  if (mine && t === `edit:${kind}`) layer.pm.enable({ snappable: true }); else if (layer.pm.enabled()) layer.pm.disable();
  if (mine && t === `drag:${kind}`) layer.pm.enableLayerDrag(); else if (layer.pm.layerDragEnabled?.()) layer.pm.disableLayerDrag();
}

/** Active un outil ; le même outil une seconde fois, ou null, revient à la sélection. */
function setTool(next) {
  const prev = tool;
  if (next === prev) next = null;
  tool = next;
  if (DRAW_TOOLS[prev]) { cutting = null; map.pm.disableDraw(); }
  generated.eachLayer((l) => { l.options.snapIgnore = !SNAP_TO_MARKS.has(next); }); // avant d'activer l'outil
  if (DRAW_TOOLS[next] && next !== 'cut' || next === 'reference') { state.sel.clear(); state.selMarks = false; }
  drawn.eachLayer((l) => applyTool(l, next));
  if (next === 'cut') cutting = selected().find(isField) ?? null;
  if (DRAW_TOOLS[next]) map.pm.enableDraw(DRAW_TOOLS[next], { snappable: true });
  map.getContainer().classList.toggle('tool-reference', tool === 'reference');
  if (tool) toast(TOOL_HINTS[tool]);
  styleDrawn();
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (tool) setTool(null); else select([]);
});
// tracé terminé ou abandonné : on revient à la sélection
map.on('pm:drawend', () => setTimeout(() => {
  if (DRAW_TOOLS[tool] && !map.pm.globalDrawModeEnabled()) { cutting = null; setTool(null); }
}, 0));

function locateMe() {
  if (!navigator.geolocation) return toast('Géolocalisation indisponible.');
  navigator.geolocation.getCurrentPosition(
    (p) => map.setView([p.coords.latitude, p.coords.longitude], 17),
    () => toast('Position refusée ou indisponible.'), { enableHighAccuracy: true, timeout: 15000 });
}

const openTool = (dialogId) => () => { setTool(null); openDialog(dialogId); };
toolbar = createToolbar(map, [
  { id: 'map', title: 'Cartographie', color: '#1565c0', buttons: [
    { id: 'zoom-in', title: 'Zoom avant', text: '+', onClick: () => map.zoomIn() },
    { id: 'zoom-out', title: 'Zoom arrière', text: '−', onClick: () => map.zoomOut() },
    { id: 'locate', title: 'Ma position', text: '📍', onClick: locateMe },
    { id: 'basemap', title: 'Fond de carte', text: '🗺️', onClick: () => { renderBasemaps(); openDialog('dlg-basemap'); } },
  ] },
  { id: 'fields', title: 'Parcelles', color: '#f9a825', buttons: [
    { id: 'reference', title: 'Créer depuis la couche de référence', text: '▦', onClick: () => (tool === 'reference' ? setTool(null) : openTool('dlg-reference')()) },
    { id: 'polygon', title: 'Dessiner une parcelle', icon: 'polygon', onClick: () => setTool('polygon') },
    { id: 'merge', title: 'Fusionner des parcelles', text: '⧉', onClick: () => (selected().length >= 2 ? mergeSelected() : setTool('merge')) },
    { id: 'cut', title: 'Couper la parcelle', icon: 'cut', onClick: () => setTool('cut') },
    { id: 'edit:field', title: 'Modifier la parcelle', icon: 'edit', onClick: () => setTool('edit:field') },
    { id: 'drag:field', title: 'Déplacer la parcelle', icon: 'drag', onClick: () => setTool('drag:field') },
    { id: 'remove:field', title: 'Supprimer la sélection', icon: 'delete', onClick: deleteSelection },
    { id: 'obstacle', title: 'Dessiner un obstacle (exclu des repères)', text: '⊘', onClick: () => setTool('obstacle') },
    { id: 'edit:obstacle', title: 'Modifier l\'obstacle', icon: 'edit', onClick: () => setTool('edit:obstacle') },
    { id: 'drag:obstacle', title: 'Déplacer l\'obstacle', icon: 'drag', onClick: () => setTool('drag:obstacle') },
    { id: 'remove:obstacle', title: 'Supprimer la sélection', icon: 'delete', onClick: deleteSelection },
  ] },
  { id: 'marks', title: 'Repères virtuels', color: '#e53935', buttons: [
    { id: 'generate', title: 'Générer les repères', text: '▤', onClick: openTool('dlg-generate') },
    { id: 'clear-gen', title: 'Supprimer les repères', icon: 'delete', onClick: clearGenerated },
  ] },
  { id: 'fences', title: 'Clôtures', color: '#00acc1', buttons: [
    { id: 'line', title: 'Dessiner une clôture', icon: 'polyline', onClick: () => setTool('line') },
    { id: 'edit:line', title: 'Modifier la clôture', icon: 'edit', onClick: () => setTool('edit:line') },
    { id: 'drag:line', title: 'Déplacer la clôture', icon: 'drag', onClick: () => setTool('drag:line') },
    { id: 'remove:line', title: 'Supprimer la sélection', icon: 'delete', onClick: deleteSelection },
  ] },
  { id: 'plan', title: 'Plan', color: '#2e7d32', buttons: [
    { id: 'plan', title: 'Plans : ouvrir, partager, exporter…', text: '📁', onClick: openTool('dlg-plan') },
  ] },
]);

/** Objets que l'on nomme depuis la pastille du bas. */
const RENAMABLE = {
  field: { unnamed: 'Parcelle sans nom', question: 'Nom de la parcelle :' },
  obstacle: { unnamed: 'Obstacle sans nom', question: 'Nom de l\'obstacle :' },
};

/**
 * N'affiche que les outils utilisables : ceux de création toujours, ceux qui agissent sur un objet
 * seulement quand la sélection s'y prête. Pendant un outil, on garde son bouton (pour en sortir).
 */
function updateToolbar() {
  if (!toolbar) return;
  const kind = selKind(), n = selected().length;
  const show = {
    reference: true, polygon: true, obstacle: true, line: true, generate: fields().length > 0,
    merge: kind === 'field',
    cut: kind === 'field' && n === 1,
    'edit:field': kind === 'field' && n === 1, 'drag:field': kind === 'field' && n === 1, 'remove:field': kind === 'field',
    'edit:obstacle': kind === 'obstacle' && n === 1, 'drag:obstacle': kind === 'obstacle' && n === 1, 'remove:obstacle': kind === 'obstacle',
    'edit:line': kind === 'line' && n === 1, 'drag:line': kind === 'line' && n === 1, 'remove:line': kind === 'line',
    'clear-gen': kind === 'marks',
  };
  for (const [id, on] of Object.entries(show)) toolbar.setVisible(id, on || tool === id);
  for (const id of Object.keys(show)) toolbar.setActive(id, id === tool);
  toolbar.setBadge('merge', tool === 'merge' || n >= 2 ? String(n) : '');
  // infos de la sélection, en bas de la carte
  const sel = selected();
  let info = '';
  const renamable = RENAMABLE[kind] && sel.length === 1;
  if (renamable) {
    const r = ringOf(sel[0]), name = nameOf(sel[0]);
    info = `<span class="info-name${name ? '' : ' empty'}">${escapeHtml(name || RENAMABLE[kind].unnamed)} ✎</span> · <b>${formatArea(areaLL(r))}</b> · périmètre ${formatLength(lengthLL([...r, r[0]]))}`;
  } else if (kind === 'field' || kind === 'obstacle') {
    info = `${sel.length} ${kind === 'field' ? 'parcelles' : 'obstacles'} : <b>${formatArea(sel.reduce((t, l) => t + areaLL(ringOf(l)), 0))}</b>`;
  }
  else if (kind === 'line') info = `${sel.length > 1 ? `${sel.length} clôtures` : 'Clôture'} : <b>${formatLength(sel.reduce((t, l) => t + lengthLL(ringOf(l)), 0))}</b>`;
  else if (kind === 'marks') info = `Repères virtuels : <b>${state.strips.length} bandes</b>`;
  $('field-info').innerHTML = info;
  $('field-info').classList.toggle('renamable', !!renamable);
}

/** Clic sur la pastille du bas : renommer l'objet sélectionné. */
$('field-info').addEventListener('click', () => {
  const sel = selected(), kind = selKind();
  if (!RENAMABLE[kind] || sel.length !== 1) return;
  const layer = sel[0];
  const name = prompt(RENAMABLE[kind].question, nameOf(layer));
  if (name == null) return; // annulé
  const clean = name.trim();
  if (clean) layer.feature.properties.name = clean; else delete layer.feature.properties.name;
  syncLayer(layer); refresh();
});

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
      if (state.mode !== 'design' || tool !== 'reference') return;
      L.DomEvent.stopPropagation(e);
      const field = addField(outerRingAt(feature, [e.latlng.lng, e.latlng.lat]));
      state.sel = new Set([field]); state.selected = field;
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
$('btn-layers').addEventListener('click', (e) => { e.preventDefault(); openDialog('dlg-layers'); renderMyLayers(); searchLayers(); });
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
});

function regenerate() {
  generated.clearLayers();
  state.genLines = []; state.strips = [];
  const field = currentField();
  if (!state.genActive || !field) return;
  const p = params();
  const ring = ringOf(field);
  const res = generateStrips(ring, {
    bearing: p.angle, mode: p.mode, reverse: p.reverse, holes: obstacles().map(ringOf),
    value: p.mode === 'area' ? p.value * 100 : p.value,
  });
  state.strips = res.strips;
  res.lines.forEach((l, i) => state.genLines.push({ id: `g:${i}`, coords: l.coords, length: l.length, label: `Repère ${l.strip}` }));
  if (p.perimeter) {
    const closed = [...ring, ring[0]];
    state.genLines.push({ id: 'p:0', coords: closed, length: lengthLL(closed), label: 'Repère du périmètre' });
  }
  for (const gl of state.genLines) {
    const isPerim = gl.id.startsWith('p');
    const pl = L.polyline(gl.coords.map(([lng, lat]) => [lat, lng]), {
      color: isPerim ? '#ffa726' : '#ff5252', weight: isPerim ? 3 : 4, baseWeight: isPerim ? 3 : 4, dashArray: isPerim ? '2 6' : '10 6',
      // pas éditables par Geoman, mais accrochables quand on trace ou modifie une clôture
      pmIgnore: true, snapIgnore: !SNAP_TO_MARKS.has(tool),
    }).addTo(generated);
    pl.bindTooltip(`${gl.label} · ${formatLength(gl.length)}`, { sticky: true, className: 'strip-tip' });
  }
}

// ---------------------------------------------------------------- clôtures à poser (guidage)
// Seules les clôtures dessinées servent au guidage : les repères virtuels n'aident qu'à les tracer.
function allLines() {
  return userLines().map((l, i) => {
    const coords = ringOf(l);
    return { id: `u:${L.stamp(l)}`, coords, length: lengthLL(coords), label: `Clôture ${i + 1}` };
  });
}

// ---------------------------------------------------------------- panneaux d'infos
function refresh(save = true) {
  regenerate();
  if (!state.genLines.length) state.selMarks = false;
  styleDrawn();
  $('strip-list').innerHTML = state.strips.length
    ? `<table>${state.strips.map((s) => `<tr><td>Bande ${s.index}</td><td>${formatArea(s.area)}</td></tr>`).join('')}</table>`
    : '';
  const p = params();
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
['gen-value', 'gen-angle', 'gen-reverse', 'gen-perimeter'].forEach((id) => $(id).addEventListener('input', () => refresh()));
$('btn-generate').addEventListener('click', () => {
  if (!currentField()) return toast('Dessinez d\'abord une parcelle (polygone).');
  state.genActive = true; refresh();
  $('dlg-generate').close();
  const f = currentField(); map.fitBounds(f.getBounds(), { padding: [30, 30], maxZoom: 19 });
});
function clearGenerated() {
  setTool(null);
  state.selMarks = false;
  if (!state.genActive) return toast('Aucun repère à supprimer.');
  state.genActive = false; refresh(); toast('Repères supprimés.');
}
$('btn-ref-use').addEventListener('click', () => {
  if (!ref.spec) return toast('Choisissez d\'abord une couche.');
  $('dlg-reference').close(); setTool('reference');
  if (map.getZoom() < REF_MIN_ZOOM) toast('Zoomez sur vos parcelles pour afficher la couche.');
});
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
    register(l, keepIds && f.properties?.id ? f.properties.id : uid(), f.properties ?? {});
    syncLayer(l); n++;
  }
  return n;
}

$('btn-export').addEventListener('click', () => {
  $('dlg-plan').close();
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
$('btn-import').addEventListener('click', () => { $('dlg-plan').close(); $('file-import').click(); });
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
  if (!confirm('Tout effacer (parcelles, clôtures et repères) ?')) return;
  $('dlg-plan').close(); setTool(null);
  state.sel.clear(); state.selMarks = false;
  drawn.clearLayers(); state.selected = null; state.genActive = false; refresh();
});

function applyParams(p) {
  if (!p) return;
  $('gen-mode').value = p.mode || 'width';
  $('gen-value-label').textContent = p.mode === 'area' ? 'Surface par bande (ares, 100 a = 1 ha)' : 'Largeur (m)';
  $('gen-value').value = p.value ?? 20; $('gen-angle').value = p.angle ?? 90;
  $('gen-reverse').checked = !!p.reverse; $('gen-perimeter').checked = p.perimeter !== false;
}

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
  $('panel-field').classList.toggle('hidden', design);
  document.body.classList.toggle('mode-design', design); document.body.classList.toggle('mode-field', !design);
  setTool(null);
  // en Terrain, seul le bloc Cartographie reste (zoom, position, fond de carte)
  toolbar.showBlocks(design ? ['map', 'fields', 'marks', 'fences', 'plan'] : ['map']);
  // les repères virtuels ne servent qu'en Conception
  if (design) { guideLayer.clearLayers(); generated.addTo(map); }
  else { generated.remove(); fillLineSelect(); resetGuidance(); drawTarget(); if (gps.last) update(); }
  setTimeout(() => map.invalidateSize(), 50);
}
$('tab-design').addEventListener('click', () => setMode('design'));
$('tab-field').addEventListener('click', () => setMode('field'));

// ---------------------------------------------------------------- plans, comptes, partage
const sessionUi = {
  applyPlan(meta, features) {
    applying = true;
    try {
      state.sel.clear(); state.selMarks = false; setTool(null);
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
    const id = feature.properties.id, old = byId.get(id), wasSelected = old && state.selected === old, wasInSel = old && state.sel.has(old);
    applying = true;
    try {
      if (old) drawn.removeLayer(old);
      byId.delete(id);
      loadFeatures({ type: 'FeatureCollection', features: [feature] }, { keepIds: true });
    } finally { applying = false; }
    if (wasSelected) state.selected = byId.get(id);
    if (wasInSel && byId.get(id)) { state.sel.add(byId.get(id)); applyTool(byId.get(id), tool); }
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

$('btn-plans').addEventListener('click', () => { if (!session) return; openDialog('dlg-plans'); renderPlans(); });
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
  if (!backend.auth.user) return openDialog('dlg-auth');
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
window.__fm = { hitTest, generated, setHeading: (deg) => { gps.heading = deg == null ? null : { deg, t: Infinity }; render(); }, map, drawn, refLayer, state, gps, register, refresh, onPos, setMode, L, ready, syncLayer, get session() { return session; }, get backend() { return backend; } }; // utile pour les tests

if (import.meta.env.PROD && !android && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
