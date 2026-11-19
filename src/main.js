import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import './style.css';
import { areaLL, lengthLL, longestEdgeBearing, formatArea, formatLength } from './geo.js';
import { generateGrid, paddockOf, fitPaddock, L_FENCE } from './generate.js';
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
// Types d'objets dessinés : parcelle ('field'), obstacle (polygone exclu des repères),
// clôture temporaire ('line', guidée en Terrain), clôture naturelle ou permanente ('permanent', seulement
// affichée) et électrificateur ('energizer', point).
const KINDS = ['field', 'obstacle', 'line', 'permanent', 'energizer'];
const LINE_KINDS = ['line', 'permanent'];
const LABELED = ['field', 'obstacle', 'permanent']; // types dont le nom s'affiche sur la carte
const isPolygon = (l) => l instanceof L.Polygon;
const isMarker = (l) => l instanceof L.Marker;
const kindOf = (l) => l.feature?.properties?.kind ?? (isMarker(l) ? 'energizer' : isPolygon(l) ? 'field' : 'line');
const energizers = () => drawn.getLayers().filter(isMarker);
const BOLT_SVG = '<svg viewBox="-9 -9 18 18" width="22" height="22" aria-hidden="true"><path d="M2-8-4 1H0L-2 8 4-1H0Z" fill="#212121"/></svg>';
const energizerIcon = (sel) => L.divIcon({ className: `energizer-icon${sel ? ' sel' : ''}`, html: BOLT_SVG, iconSize: [30, 30], iconAnchor: [15, 15] });
const isField = (l) => kindOf(l) === 'field';
const isObstacle = (l) => kindOf(l) === 'obstacle';
const nameOf = (l) => l.feature?.properties?.name ?? '';
const colorOf = (l) => l.feature?.properties?.color ?? '';
// couleurs proposées pour les clôtures temporaires (pinceau de la pastille)
const FENCE_COLORS = ['#ff1744', '#ff9100', '#ffea00', '#76ff03', '#00c853', '#2979ff', '#f50057', '#ffffff', '#8d6e63'];
const fields = () => drawn.getLayers().filter(isField);
const obstacles = () => drawn.getLayers().filter(isObstacle);
const userLines = () => drawn.getLayers().filter((l) => kindOf(l) === 'line'); // clôtures temporaires (guidage)
const allFences = () => drawn.getLayers().filter((l) => LINE_KINDS.includes(kindOf(l)));
/** Parcelle des repères : la dernière sélectionnée, sinon celle des paramètres enregistrés, sinon la dernière. */
const currentField = () => {
  if (state.selected && drawn.hasLayer(state.selected)) return state.selected;
  const saved = byId.get(state.genFieldId);
  return saved && drawn.hasLayer(saved) && isField(saved) ? saved : fields().slice(-1)[0] || null;
};
const selected = () => [...state.sel].filter((l) => drawn.hasLayer(l));
/** Type de la sélection : 'field', 'obstacle', 'line', 'permanent', 'marks' ou null. */
const selKind = () => (state.selMarks ? 'marks' : selected()[0] ? kindOf(selected()[0]) : null);

const STYLE = {
  field: { color: '#ffeb3b', weight: 3, fillColor: '#ffeb3b', fillOpacity: 0.08 },
  fieldSel: { color: '#ff9800', weight: 4, fillColor: '#ff9800', fillOpacity: 0.12 },
  obstacle: { color: '#d84315', weight: 2, dashArray: '6 4', fillColor: '#3e2723', fillOpacity: 0.45 },
  obstacleSel: { color: '#ff9800', weight: 4, dashArray: null, fillColor: '#3e2723', fillOpacity: 0.55 },
  line: { color: '#00e5ff', weight: 4 },
  lineSel: { color: '#2979ff', weight: 7 },
  permanent: { color: '#ab47bc', weight: 4 },
  permanentSel: { color: '#2979ff', weight: 7 },
};

function styleDrawn() {
  drawn.eachLayer((l) => {
    if (isMarker(l)) { // électrificateur : on ne change l'icône que si la sélection a changé
      const sel = state.sel.has(l);
      if (l._sel !== sel) { // nouvelle icône : Geoman doit se rebrancher sur le nouvel élément
        l._sel = sel; l.setIcon(energizerIcon(sel));
        if (l.pm?.enabled()) { l.pm.disable(); l.pm.enable({ snappable: true, draggable: true }); }
      }
      return;
    }
    const k = kindOf(l), sel = state.sel.has(l), own = k === 'line' && colorOf(l);
    // clôture temporaire colorée : sa couleur, et un trait plus épais quand elle est sélectionnée
    l.setStyle(own ? { color: own, weight: sel ? 8 : 4 } : STYLE[sel ? `${k}Sel` : k]);
    // nom affiché sur la carte (parcelles, obstacles, clôtures permanentes)
    const label = LABELED.includes(k) ? nameOf(l) : '';
    if (label) {
      if (!l.getTooltip()) l.bindTooltip('', { permanent: true, direction: 'center', className: `name-label name-${k}` });
      l.setTooltipContent(escapeHtml(label));
      l.openTooltip(); // recentre l'étiquette si la forme a changé
    } else if (l.getTooltip()) l.unbindTooltip();
  });
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
  const shape = isMarker(layer) ? 'point' : isPolygon(layer) ? 'polygon' : 'line';
  const kind = shape === 'point' ? 'energizer'
    : KINDS.includes(props.kind) && props.kind !== 'energizer' && LINE_KINDS.includes(props.kind) === (shape === 'line') ? props.kind
      : (shape === 'polygon' ? 'field' : 'line');
  if (shape === 'point') {
    layer.setIcon(energizerIcon(false)); layer._sel = false;
    layer.options.bubblingMouseEvents = true; // le clic remonte à la carte : sélection commune (hitTest)
  }
  const color = kind === 'line' && /^#[0-9a-f]{6}$/i.test(props.color ?? '') ? props.color : null;
  layer.feature = { type: 'Feature', properties: { id, kind, ...(props.name ? { name: String(props.name) } : {}), ...(color ? { color } : {}) }, geometry: null };
  byId.set(id, layer);
  if (!drawn.hasLayer(layer)) drawn.addLayer(layer);
  // en Conception, la sélection passe par un clic sur la carte (voir hitTest)
  layer.on('click', (e) => {
    if (state.mode !== 'field') return;
    if (kindOf(layer) === 'line') pickLine(`u:${L.stamp(layer)}`);
    // en Terrain, l'électrificateur ouvre sa fenêtre (et le clic ne déplace pas la position simulée)
    if (kindOf(layer) === 'energizer') { L.DomEvent.stopPropagation(e); openEnergizer(layer); }
  });
  // dernière forme acceptée (clôture temporaire : 280 m au plus) ; copie, car Geoman modifie les points en place
  const copy = (ll) => (Array.isArray(ll) ? ll.map(copy) : L.latLng(ll.lat, ll.lng));
  layer._good = isMarker(layer) ? null : copy(layer.getLatLngs());
  ['pm:edit', 'pm:dragend', 'pm:vertexadded', 'pm:vertexremoved', 'dragend'].forEach((ev) => layer.on(ev, () => {
    if (kindOf(layer) === 'line' && lengthLL(ringOf(layer)) > MAX_TEMP + 0.01) {
      // modification refusée : on revient à la forme précédente
      layer.setLatLngs(layer._good);
      if (layer.pm.enabled()) { layer.pm.disable(); layer.pm.enable({ snappable: true }); }
      toast(`Une clôture temporaire mesure ${MAX_TEMP} m au plus.`);
      return;
    }
    if (!isMarker(layer)) layer._good = copy(layer.getLatLngs());
    syncLayer(layer); refresh();
  }));
  applyTool(layer, tool);
  styleDrawn();
}

map.on('pm:create', (e) => {
  if (cutting) { // la ligne tracée est un trait de coupe, pas une clôture
    const target = cutting, line = ringOf(e.layer);
    cutting = null; e.layer.remove();
    return cutField(target, line);
  }
  register(e.layer, uid(), { kind: tool === 'obstacle' || tool === 'permanent' ? tool : undefined });
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
  const lines = allFences().map((l) => ({ l, d: distToLine(pt, l) })).filter((c) => c.d <= HIT_PX);
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

// ---------------------------------------------------------------- clôture temporaire : 280 m au plus
// Pendant le tracé, la pastille du bas indique la longueur et ce qui reste ; un point qui ferait
// dépasser 280 m est ramené à 280 m exactement sur son segment, et le tracé se termine.
const MAX_TEMP = L_FENCE;
let tempDraw = null; // calque de travail Geoman pendant le tracé d'une clôture temporaire

function showTempLength(extra) {
  if (!tempDraw) return;
  const pts = tempDraw.getLatLngs().map((p) => [p.lng, p.lat]);
  if (extra) pts.push([extra.lng, extra.lat]);
  const len = pts.length > 1 ? lengthLL(pts) : 0, over = len > MAX_TEMP + 0.01;
  $('field-info').classList.remove('renamable');
  $('field-info').innerHTML = over
    ? `Clôture temporaire : <b class="warn-text">${fmtM(len)} m</b> · arrêt à ${MAX_TEMP} m`
    : `Clôture temporaire : <b>${fmtM(len)} m</b> · reste <b>${fmtM(Math.max(0, MAX_TEMP - len))} m</b>`;
}
map.on('pm:drawstart', (e) => {
  if (tool !== 'line' || e.shape !== 'Line') return;
  tempDraw = e.workingLayer;
  showTempLength();
  tempDraw.on('pm:vertexadded', () => {
    const pts = tempDraw.getLatLngs(), ll = pts.map((p) => [p.lng, p.lat]), len = lengthLL(ll);
    if (len < MAX_TEMP - 0.05) return showTempLength();
    if (len > MAX_TEMP + 0.01) {
      // dernier point ramené sur son segment, à 280 m du départ
      const a = ll.at(-2), b = ll.at(-1), seg = lengthLL([a, b]), k = (MAX_TEMP - (len - seg)) / seg;
      const p = L.latLng(a[1] + (b[1] - a[1]) * k, a[0] + (b[0] - a[0]) * k);
      tempDraw.setLatLngs([...pts.slice(0, -1), p]);
    }
    // Geoman finit d'enregistrer le point avant qu'on termine le tracé
    setTimeout(() => { if (map.pm.Draw.Line.enabled()) map.pm.Draw.Line._finishShape(); }, 0);
    toast(`Clôture de ${MAX_TEMP} m : tracé terminé.`);
  });
});
map.on('pm:drawend', () => { tempDraw = null; });
map.on('mousemove', () => {
  if (tempDraw && tempDraw.getLatLngs().length) showTempLength(map.pm.Draw.Line._hintMarker?.getLatLng());
});

// ---------------------------------------------------------------- barre d'outils (Conception)
// Un seul outil actif à la fois. Modifier / Déplacer / Supprimer agissent sur la sélection :
// on active Geoman objet par objet plutôt qu'en mode global.
const DRAW_TOOLS = { polygon: 'Polygon', obstacle: 'Polygon', line: 'Line', permanent: 'Line', cut: 'Line', energizer: 'Marker' };
const TOOL_KEEPS_SELECTION = new Set(['merge']);
// outils pendant lesquels les repères virtuels attirent le curseur (accrochage Geoman)
const SNAP_TO_MARKS = new Set(['line', 'edit:line', 'permanent', 'edit:permanent']);
const TOOL_HINTS = {
  polygon: 'Cliquez les sommets de la parcelle, puis le premier point pour la fermer.',
  obstacle: 'Cliquez les sommets de l\'obstacle, puis le premier point pour le fermer.',
  line: `Clôture temporaire (${L_FENCE} m au plus) : cliquez ses points, puis à nouveau le dernier pour terminer.`,
  permanent: 'Clôture permanente : cliquez ses points, puis à nouveau le dernier point pour terminer.',
  'edit:permanent': 'Déplacez les points de la clôture.',
  'drag:permanent': 'Faites glisser la clôture pour la déplacer.',
  energizer: 'Cliquez pour placer l\'électrificateur (il s\'accroche aux clôtures).',
  'drag:energizer': 'Faites glisser l\'électrificateur pour le déplacer.',
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
  if (isMarker(layer)) { // un point se déplace en le faisant glisser (Geoman : accrochage aux clôtures)
    if (mine && t === 'drag:energizer') layer.pm.enable({ snappable: true, draggable: true }); else if (layer.pm.enabled()) layer.pm.disable();
    return;
  }
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
  if (DRAW_TOOLS[next]) {
    map.pm.enableDraw(DRAW_TOOLS[next], { snappable: true, ...(next === 'energizer' ? { markerStyle: { icon: energizerIcon(false) }, continueDrawing: false } : {}) });
  }
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
    { id: 'generate', title: 'Repères : réglages en direct', text: '▤', onClick: () => openMarksPanel() },
    { id: 'clear-gen', title: 'Supprimer les repères', icon: 'delete', onClick: clearGenerated },
  ] },
  { id: 'fences', title: 'Clôtures', color: '#00acc1', buttons: [
    { id: 'permanent', title: 'Dessiner une clôture naturelle ou permanente', text: '━', color: STYLE.permanent.color, onClick: () => setTool('permanent') },
    { id: 'line', title: 'Dessiner une clôture temporaire (280 m au plus)', text: '┅', color: '#00a5bd', onClick: () => setTool('line') },
    { id: 'energizer', title: 'Placer un électrificateur', text: '⚡', onClick: () => setTool('energizer') },
    { id: 'drag:energizer', title: 'Déplacer l\'électrificateur', icon: 'drag', onClick: () => setTool('drag:energizer') },
    { id: 'remove:energizer', title: 'Supprimer la sélection', icon: 'delete', onClick: deleteSelection },
    { id: 'switch-fence', title: 'Changer de type (permanente ↔ temporaire)', text: '⇄', onClick: switchFenceKind },
    { id: 'edit:line', title: 'Modifier la clôture', icon: 'edit', onClick: () => setTool('edit:line') },
    { id: 'drag:line', title: 'Déplacer la clôture', icon: 'drag', onClick: () => setTool('drag:line') },
    { id: 'remove:line', title: 'Supprimer la sélection', icon: 'delete', onClick: deleteSelection },
    { id: 'edit:permanent', title: 'Modifier la clôture', icon: 'edit', onClick: () => setTool('edit:permanent') },
    { id: 'drag:permanent', title: 'Déplacer la clôture', icon: 'drag', onClick: () => setTool('drag:permanent') },
    { id: 'remove:permanent', title: 'Supprimer la sélection', icon: 'delete', onClick: deleteSelection },
  ] },
  { id: 'plan', title: 'Plan', color: '#2e7d32', buttons: [
    { id: 'plan', title: 'Plans : ouvrir, partager, exporter…', text: '📁', onClick: openTool('dlg-plan') },
  ] },
]);

/** Objets que l'on nomme depuis la pastille du bas. */
const RENAMABLE = {
  field: { unnamed: 'Parcelle sans nom', question: 'Nom de la parcelle :' },
  obstacle: { unnamed: 'Obstacle sans nom', question: 'Nom de l\'obstacle :' },
  line: { unnamed: 'Clôture temporaire sans nom', question: 'Nom de la clôture :' },
  permanent: { unnamed: 'Clôture permanente sans nom', question: 'Nom de la clôture :' },
  energizer: { unnamed: 'Électrificateur sans nom', question: 'Nom de l\'électrificateur :' },
};

/** Clôture la plus proche d'un point : « sur … » ou « à 12 m de … ». */
function fenceNear(latlng) {
  const pt = map.latLngToLayerPoint(latlng);
  let best = null;
  for (const l of allFences()) {
    const pts = l.getLatLngs().map((p) => map.latLngToLayerPoint(p));
    for (let i = 1; i < pts.length; i++) {
      const q = L.LineUtil.closestPointOnSegment(pt, pts[i - 1], pts[i]);
      const d = map.distance(latlng, map.layerPointToLatLng(q));
      if (!best || d < best.d) best = { l, d };
    }
  }
  if (!best) return 'aucune clôture';
  const i = allFences().filter((l) => kindOf(l) === kindOf(best.l)).indexOf(best.l) + 1;
  const name = nameOf(best.l) || `${kindOf(best.l) === 'line' ? 'clôture' : 'clôture permanente'} ${i}`;
  return best.d < 1 ? `sur « ${escapeHtml(name)} »` : `à ${formatLength(best.d)} de « ${escapeHtml(name)} »`;
}

/** Fenêtre des couleurs d'une clôture temporaire. */
function openColors(layer) {
  const box = $('color-list'), cur = colorOf(layer);
  box.innerHTML = '';
  const pick = (color) => {
    if (color) layer.feature.properties.color = color; else delete layer.feature.properties.color;
    syncLayer(layer); $('dlg-color').close(); refresh();
  };
  for (const c of [null, ...FENCE_COLORS]) {
    const b = document.createElement('button');
    b.className = 'swatch' + ((c ?? '') === cur ? ' current' : '');
    b.style.setProperty('--c', c ?? STYLE.line.color);
    b.title = c ? c : 'Couleur par défaut';
    if (!c) b.textContent = 'défaut';
    b.addEventListener('click', () => pick(c));
    box.appendChild(b);
  }
  openDialog('dlg-color');
}

/** Bascule les clôtures sélectionnées entre temporaire (guidée) et permanente (seulement affichée). */
function switchFenceKind() {
  const sel = selected().filter((l) => LINE_KINDS.includes(kindOf(l)));
  if (!sel.length) return;
  const to = kindOf(sel[0]) === 'line' ? 'permanent' : 'line';
  if (to === 'line' && sel.some((l) => lengthLL(ringOf(l)) > MAX_TEMP + 0.01)) {
    return toast(`Impossible : une clôture temporaire mesure ${MAX_TEMP} m au plus.`);
  }
  setTool(null);
  for (const l of sel) { l.feature.properties.kind = to; syncLayer(l); }
  refresh();
  toast(to === 'line' ? 'Clôture temporaire : proposée au guidage.' : 'Clôture permanente : affichée, sans guidage.');
}

// écran tactile : on zoome en pinçant la carte, les boutons de zoom ne servent qu'à la souris
if (matchMedia('(pointer: coarse)').matches) { toolbar.setVisible('zoom-in', false); toolbar.setVisible('zoom-out', false); }

/**
 * N'affiche que les outils utilisables : ceux de création toujours, ceux qui agissent sur un objet
 * seulement quand la sélection s'y prête. Pendant un outil, on garde son bouton (pour en sortir).
 */
function updateToolbar() {
  if (!toolbar) return;
  const kind = selKind(), n = selected().length;
  const show = {
    reference: true, polygon: true, obstacle: true, line: true, permanent: true, energizer: true, generate: fields().length > 0,
    'drag:energizer': kind === 'energizer' && n === 1, 'remove:energizer': kind === 'energizer',
    'switch-fence': kind === 'line' || kind === 'permanent',
    merge: kind === 'field',
    cut: kind === 'field' && n === 1,
    'edit:field': kind === 'field' && n === 1, 'drag:field': kind === 'field' && n === 1, 'remove:field': kind === 'field',
    'edit:obstacle': kind === 'obstacle' && n === 1, 'drag:obstacle': kind === 'obstacle' && n === 1, 'remove:obstacle': kind === 'obstacle',
    'edit:line': kind === 'line' && n === 1, 'drag:line': kind === 'line' && n === 1, 'remove:line': kind === 'line',
    'edit:permanent': kind === 'permanent' && n === 1, 'drag:permanent': kind === 'permanent' && n === 1, 'remove:permanent': kind === 'permanent',
    'clear-gen': kind === 'marks',
  };
  for (const [id, on] of Object.entries(show)) toolbar.setVisible(id, on || tool === id);
  for (const id of Object.keys(show)) toolbar.setActive(id, id === tool || (id === 'generate' && !$('panel-marks').hidden));
  toolbar.setBadge('merge', tool === 'merge' || n >= 2 ? String(n) : '');
  // infos de la sélection, en bas de la carte
  const sel = selected();
  let info = '';
  const renamable = RENAMABLE[kind] && sel.length === 1;
  const isFence = LINE_KINDS.includes(kind);
  if (renamable && kind === 'energizer') {
    const name = nameOf(sel[0]);
    info = `⚡ <span class="info-name${name ? '' : ' empty'}">${escapeHtml(name || RENAMABLE[kind].unnamed)} ✎</span> · ${fenceNear(sel[0].getLatLng())}`;
  } else if (kind === 'energizer') info = `${sel.length} électrificateurs`;
  else if (renamable) {
    const r = ringOf(sel[0]), name = nameOf(sel[0]);
    const len = lengthLL(r);
    const rest = kind !== 'line' ? '' : len > MAX_TEMP + 0.01 ? ` · <span class="warn-text">plus de ${MAX_TEMP} m</span>` : ` · reste ${fmtM(Math.max(0, MAX_TEMP - len))} m`;
    const size = isFence ? `<b>${formatLength(len)}</b>${rest}` : `<b>${formatArea(areaLL(r))}</b> · périmètre ${formatLength(lengthLL([...r, r[0]]))}`;
    const brush = kind === 'line' ? `<span class="info-brush" title="Couleur de la clôture" style="--c:${colorOf(sel[0]) || STYLE.line.color}">🖌</span> ` : '';
    info = `${brush}<span class="info-name${name ? '' : ' empty'}">${escapeHtml(name || RENAMABLE[kind].unnamed)} ✎</span> · ${size}`;
  } else if (kind === 'field' || kind === 'obstacle') {
    info = `${sel.length} ${kind === 'field' ? 'parcelles' : 'obstacles'} : <b>${formatArea(sel.reduce((t, l) => t + areaLL(ringOf(l)), 0))}</b>`;
  }
  else if (isFence) info = `${sel.length} clôtures ${kind === 'line' ? 'temporaires' : 'permanentes'} : <b>${formatLength(sel.reduce((t, l) => t + lengthLL(ringOf(l)), 0))}</b>`;
  else if (kind === 'marks') {
    const nSec = state.genLines.filter((g) => g.id[0] === 's').length;
    info = `Repères virtuels : <b>${state.strips.length} bandes</b>${nSec ? ` · ${nSec} lignes secondaires` : ''}`;
  }
  $('field-info').innerHTML = info;
  $('field-info').classList.toggle('renamable', !!renamable);
}

/** Clic sur la pastille du bas : pinceau = couleur de la clôture, ailleurs = renommer l'objet. */
$('field-info').addEventListener('click', (e) => {
  const sel = selected(), kind = selKind();
  if (!RENAMABLE[kind] || sel.length !== 1) return;
  if (e.target.closest('.info-brush')) return openColors(sel[0]);
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

// ---------------------------------------------------------------- génération (repères virtuels)
const num = (id, dflt = 0) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : dflt; };
const params = () => ({
  mode: $('gen-mode').value,
  value: num('gen-value'),
  angle: parseInt($('gen-angle').value, 10),
  reverse: $('gen-reverse').checked,
  perimeter: $('gen-perimeter').checked,
  offset: num('gen-offset'),
  field: currentField()?.feature?.properties?.id ?? null, // parcelle sur laquelle portent les repères
  sec: {
    on: $('sec-on').checked, mode: $('sec-mode').value, value: num('sec-value'), capL: $('sec-cap').checked,
    angle: parseInt($('sec-angle').value, 10), offset: num('sec-offset'),
  },
});

/**
 * Quadrillage demandé. Lignes secondaires :
 *  - en largeur (m), sans plafond : lignes continues d'espacement fixe ;
 *  - en surface de paddock, ou avec le plafond « L de 280 m » : placées bande par bande
 *    (spacingFor), car l'espacement dépend de la largeur de chaque bande principale.
 * `a` : espacement des principales s'il est fixe ; `problem` : pourquoi il n'y a pas de secondaires.
 */
function gridOf(p) {
  const a = p.mode === 'width' && p.value > 0 ? p.value : null;
  if (!p.sec.on) return { a };
  const between = p.sec.angle - p.angle, sin = Math.abs(Math.sin(between * Math.PI / 180));
  if (sin < 0.05) return { a, between, problem: 'Les lignes secondaires sont presque parallèles aux principales.' };
  if (!(p.sec.value > 0)) return { a, between };
  const wanted = (w) => (p.sec.mode === 'width' ? p.sec.value : (p.sec.value * 100 * sin) / w);
  const cap = (w) => L_FENCE * sin - w; // espacement maximal pour qu'une L de 280 m ferme le paddock
  const perStrip = p.sec.mode === 'paddock' || p.sec.capL;
  const spacingFor = (w) => {
    const b = p.sec.capL ? Math.min(wanted(w), cap(w)) : wanted(w);
    return b >= 1 ? b : null;
  };
  return { a, between, sin, wanted, cap, perStrip, spacingFor, capL: p.sec.capL, b: perStrip ? null : p.sec.value };
}

const MARK_STYLE = {
  g: { color: '#ff5252', weight: 4, dashArray: '10 6' },  // lignes principales
  s: { color: '#ffb300', weight: 3, dashArray: '6 6' },   // lignes secondaires
  p: { color: '#ffa726', weight: 3, dashArray: '2 6' },   // périmètre
};

function regenerate() {
  generated.clearLayers();
  state.genLines = []; state.strips = []; state.paddocks = [];
  const field = currentField();
  if (!state.genActive || !field) return;
  const p = params(), grid = gridOf(p);
  const ring = ringOf(field);
  const res = generateGrid(ring, {
    holes: obstacles().map(ringOf),
    primary: { bearing: p.angle, mode: p.mode, reverse: p.reverse, offset: p.mode === 'width' ? p.offset : 0, value: p.mode === 'area' ? p.value * 100 : p.value },
    secondary: grid.spacingFor && !grid.problem
      ? { bearing: p.sec.angle, mode: 'width', value: grid.b ?? 1, offset: p.sec.offset, ...(grid.perStrip ? { spacingFor: grid.spacingFor } : {}) }
      : null,
  });
  state.strips = res.strips;
  state.paddocks = res.paddocks;
  res.lines.forEach((l, i) => state.genLines.push({ id: `g:${i}`, coords: l.coords, length: l.length, label: `Repère ${l.strip}` }));
  res.secondary.forEach((l, i) => state.genLines.push({ id: `s:${i}`, coords: l.coords, length: l.length, label: `Repère secondaire ${l.strip}` }));
  if (p.perimeter) {
    const closed = [...ring, ring[0]];
    state.genLines.push({ id: 'p:0', coords: closed, length: lengthLL(closed), label: 'Repère du périmètre' });
  }
  for (const gl of state.genLines) {
    const st = MARK_STYLE[gl.id[0]];
    const pl = L.polyline(gl.coords.map(([lng, lat]) => [lat, lng]), {
      ...st, baseWeight: st.weight,
      // pas éditables par Geoman, mais accrochables quand on trace ou modifie une clôture
      pmIgnore: true, snapIgnore: !SNAP_TO_MARKS.has(tool),
    }).addTo(generated);
    pl.bindTooltip(`${gl.label} · ${formatLength(gl.length)}`, { sticky: true, className: 'strip-tip' });
  }
}

/** Panneau des repères : valeurs affichées, bornes des décalages, paddock et clôture en L. */
function renderMarksPanel() {
  const p = params(), grid = gridOf(p), f = currentField();
  $('gen-angle-val').textContent = `${p.angle}°`;
  $('sec-angle-val').textContent = `${p.sec.angle}°`;
  $('gen-offset-box').hidden = p.mode !== 'width';
  $('gen-offset').max = Math.max(1, p.value || 1);
  $('gen-offset-val').textContent = `${num('gen-offset')} m`;
  $('sec-offset').max = Math.max(1, Math.round(grid.b ?? Math.max(1, ...(state.paddocks ?? []).map((d) => d.spacing || 0))) || 1);
  $('sec-offset-val').textContent = `${num('sec-offset')} m`;
  $('sec-box').hidden = !p.sec.on;
  $('marks-field').innerHTML = f
    ? `Parcelle : <b>${escapeHtml(nameOf(f) || 'sans nom')}</b> · ${formatArea(areaLL(ringOf(f)))}`
    : 'Sélectionnez ou dessinez d\'abord une parcelle.';
  let info = '';
  if (grid.problem) info = `<span class="warn-text">${grid.problem}</span>`;
  else if (grid.perStrip && state.paddocks?.length) info = paddockSummary(grid);
  else if (grid.a && grid.b) {
    const pad = paddockOf(grid.a, grid.b, grid.between), ok = Math.abs(pad.lFence - L_FENCE) < 0.5;
    info = `Paddock : <b>${fmtM(grid.a)} × ${fmtM(grid.b)} m</b> · ${formatArea(pad.area)}<br>
      Clôture en L : <b class="${ok ? 'ok-text' : 'warn-text'}">${fmtM(pad.lFence)} m</b> ${ok ? '✔' : `(${pad.lFence > L_FENCE ? 'plus' : 'moins'} que ${L_FENCE} m)`}
      ${ok ? '' : `<div class="row"><button id="btn-fit-l">Ajuster pour une L de ${L_FENCE} m</button></div>`}`;
  } else if (p.sec.on && !grid.a) info = '<span class="hint">Le paddock et la clôture en L se calculent quand les lignes principales sont espacées en mètres.</span>';
  $('grid-info').innerHTML = info;
  $('strip-list').innerHTML = state.strips.length && !p.sec.on
    ? `<table>${state.strips.map((s) => `<tr><td>Bande ${s.index}</td><td>${formatArea(s.area)}</td></tr>`).join('')}</table>`
    : '';
}
const fmtM = (v) => (Math.round(v * 10) / 10).toLocaleString('fr-FR');
const range = (vals, fmt) => { const lo = Math.min(...vals), hi = Math.max(...vals); return fmt(lo) === fmt(hi) ? fmt(lo) : `${fmt(lo)} à ${fmt(hi)}`; };

/** Résumé des paddocks quand les secondaires sont placées bande par bande. */
function paddockSummary(grid) {
  // seules comptent les bandes réellement divisées (une bande de bord très étroite peut demander
  // un espacement plus grand que le champ : elle n'a alors aucune ligne secondaire)
  const pads = state.paddocks.filter((d) => d.spacing > 0 && d.lines > 0).map((d) => ({
    ...d, ...paddockOf(d.width, d.spacing, grid.between), capped: d.spacing < grid.wanted(d.width) - 0.05,
  }));
  const none = state.paddocks.filter((d) => !(d.spacing > 0)).length, capped = pads.filter((d) => d.capped).length;
  if (!pads.length) return `<span class="warn-text">Aucune ligne secondaire possible : bandes trop larges pour une L de ${L_FENCE} m.</span>`;
  const lMax = Math.max(...pads.map((d) => d.lFence)), ok = lMax <= L_FENCE + 0.5;
  return `Paddocks : <b>${range(pads.map((d) => d.area), formatArea)}</b><br>
    Clôture en L : <b class="${ok ? 'ok-text' : 'warn-text'}">${range(pads.map((d) => d.lFence), (v) => `${fmtM(v)} m`)}</b> ${ok ? '✔' : `(plus que ${L_FENCE} m)`}
    ${capped ? `<br><small>${capped} bande${capped > 1 ? 's' : ''} : paddocks réduits pour tenir dans une L de ${L_FENCE} m.</small>` : ''}
    ${!ok && grid.a && !grid.capL ? `<div class="row"><button id="btn-fit-l">Ajuster pour une L de ${L_FENCE} m</button></div>` : ''}
    ${none ? `<br><small class="warn-text">${none} bande${none > 1 ? 's' : ''} sans ligne secondaire (plus large${none > 1 ? 's' : ''} qu'une L de ${L_FENCE} m ne le permet).</small>` : ''}`;
}

// ---------------------------------------------------------------- clôtures à poser (guidage)
// Seules les clôtures dessinées servent au guidage : les repères virtuels n'aident qu'à les tracer.
function allLines() {
  return userLines().map((l, i) => {
    const coords = ringOf(l);
    return { id: `u:${L.stamp(l)}`, coords, length: lengthLL(coords), label: nameOf(l) || `Clôture ${i + 1}` };
  });
}

// ---------------------------------------------------------------- panneaux d'infos
function refresh(save = true) {
  regenerate();
  if (!state.genLines.length) state.selMarks = false;
  styleDrawn();
  renderMarksPanel();
  fillLineSelect();
  if (save && !applying) session?.saveMeta({ params: params(), genActive: state.genActive });
}

// ---------------------------------------------------------------- panneau des repères (en direct)
const LABELS = {
  gen: { width: 'Largeur (m)', area: 'Surface par bande (ares, 100 a = 1 ha)' },
  sec: { width: 'Largeur (m)', paddock: 'Surface de paddock (ares, 100 a = 1 ha)' },
};
const setLabels = () => {
  $('gen-value-label').textContent = LABELS.gen[$('gen-mode').value];
  $('sec-value-label').textContent = LABELS.sec[$('sec-mode').value];
};
$('gen-mode').addEventListener('change', () => { $('gen-value').value = $('gen-mode').value === 'area' ? 30 : 20; setLabels(); refresh(); });
$('sec-mode').addEventListener('change', () => { $('sec-value').value = 100; setLabels(); refresh(); });
['gen-value', 'gen-angle', 'gen-reverse', 'gen-perimeter', 'gen-offset', 'sec-value', 'sec-angle', 'sec-offset', 'sec-cap']
  .forEach((id) => $(id).addEventListener('input', () => refresh()));
const perpendicular = () => { $('sec-angle').value = (parseInt($('gen-angle').value, 10) + 90) % 180; };
$('sec-on').addEventListener('change', () => { if ($('sec-on').checked && !state.secTouched) perpendicular(); state.secTouched = true; refresh(); });
$('btn-sec-perp').addEventListener('click', () => { perpendicular(); refresh(); });
$('grid-info').addEventListener('click', (e) => {
  if (e.target.id !== 'btn-fit-l') return;
  // garde la surface du paddock, et trouve les espacements qui donnent une clôture en L de 280 m
  const p = params(), grid = gridOf(p);
  if (!grid.a) return;
  // surface de paddock visée : la consigne en mode surface, sinon celle du paddock actuel
  const pad = p.sec.mode === 'paddock' ? { area: p.sec.value * 100 } : grid.b ? paddockOf(grid.a, grid.b, grid.between) : null;
  if (!pad) return;
  const { fit, maxArea } = fitPaddock(pad.area, grid.between, { near: grid.a });
  if (!fit) return toast(`Paddock trop grand pour une clôture en L de ${L_FENCE} m (maximum ${formatArea(maxArea)}).`);
  const sin = Math.abs(Math.sin(grid.between * Math.PI / 180));
  $('gen-value').value = Math.round(fit.a * 10) / 10;
  // en surface de paddock, la surface reste la consigne ; sinon on règle l'espacement des secondaires
  if (p.sec.mode === 'width') $('sec-value').value = Math.round((L_FENCE * sin - Math.round(fit.a * 10) / 10) * 10) / 10;
  refresh();
});

function openMarksPanel(open = $('panel-marks').hidden) {
  if (open && !currentField()) return toast('Dessinez d\'abord une parcelle (polygone).');
  $('panel-marks').hidden = !open;
  document.body.classList.toggle('marks-open', open);
  if (open) { setTool(null); state.genActive = true; refresh(); }
  toolbar.setActive('generate', open);
  setTimeout(() => map.invalidateSize(), 50);
}
$('btn-marks-close').addEventListener('click', () => openMarksPanel(false));
function clearGenerated() {
  setTool(null);
  if (!$('panel-marks').hidden) openMarksPanel(false);
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
  const ids = new Map(); // identifiant d'origine -> nouvel identifiant (import)
  for (const [f, l] of layers) {
    if (!(l instanceof L.Polyline) && !isMarker(l)) continue;
    const id = keepIds && f.properties?.id ? f.properties.id : uid();
    if (f.properties?.id) ids.set(f.properties.id, id);
    register(l, id, f.properties ?? {});
    syncLayer(l); n++;
  }
  loadFeatures.ids = ids;
  return n;
}

$('btn-export').addEventListener('click', () => {
  $('dlg-plan').close();
  // les repères ne sont pas exportés comme lignes : seulement leurs paramètres (fency.params), qui
  // permettent de les recalculer à l'import ; params.field désigne la parcelle concernée
  const fc = drawn.toGeoJSON(8);
  fc.fency = { version: 2, name: session?.current?.name, params: params(), genActive: state.genActive };
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
    // la parcelle des repères a reçu un nouvel identifiant à l'import
    if (meta?.params) applyParams({ ...meta.params, field: loadFeatures.ids.get(meta.params.field) ?? null });
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
  if (p.field) { state.genFieldId = p.field; state.selected = null; }
  $('gen-mode').value = p.mode === 'area' ? 'area' : 'width';
  $('gen-value').value = p.value ?? 20; $('gen-angle').value = p.angle ?? 90;
  $('gen-reverse').checked = !!p.reverse; $('gen-perimeter').checked = p.perimeter !== false;
  // bornes larges d'abord, sinon le curseur rognerait la valeur (elles sont recalculées ensuite)
  $('gen-offset').max = $('sec-offset').max = 100000;
  $('gen-offset').value = p.offset ?? 0;
  const sec = p.sec ?? {};
  $('sec-on').checked = !!sec.on; state.secTouched = !!sec.on || state.secTouched;
  $('sec-mode').value = sec.mode === 'paddock' ? 'paddock' : 'width';
  $('sec-value').value = sec.value ?? 100;
  $('sec-angle').value = sec.angle ?? ((($('gen-angle').value | 0) + 90) % 180);
  $('sec-offset').value = sec.offset ?? 0;
  $('sec-cap').checked = !!sec.capL;
  setLabels();
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
    others: [
      ...drawn.getLayers().filter((l) => kindOf(l) === 'permanent').map((l) => ({ pts: ringOf(l).map((ll) => cam(prep.proj.toXY(ll))), color: STYLE.permanent.color })),
      ...obstacles().map((l) => ({ pts: ringOf(l).map((ll) => cam(prep.proj.toXY(ll))), color: STYLE.obstacle.color, closed: true, dash: [8, 6] })),
    ],
    energizers: energizers().map((l) => { const p = l.getLatLng(); return cam(prep.proj.toXY([p.lng, p.lat])); }),
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
  showNearestEnergizer();
  update();
}

// ---------------------------------------------------------------- électrificateurs en Terrain
/** Distance au plus proche électrificateur, sous les boutons du guidage. */
function showNearestEnergizer() {
  const list = energizers();
  if (!gps.last || !list.length) { $('energizer-near').textContent = ''; return; }
  const here = L.latLng(gps.last[1], gps.last[0]);
  const best = list.map((l) => ({ l, d: here.distanceTo(l.getLatLng()) })).sort((a, b) => a.d - b.d)[0];
  $('energizer-near').textContent = `Le plus proche${nameOf(best.l) ? ` (${nameOf(best.l)})` : ''} : ${formatLength(best.d)}`;
}
const here = () => (gps.last ? L.latLng(gps.last[1], gps.last[0]) : null);
$('btn-energizer-here').addEventListener('click', () => {
  if (!here()) return toast('Démarrez le GPS (ou la simulation) pour connaître votre position.');
  const m = L.marker(here());
  register(m); syncLayer(m); refresh(); showNearestEnergizer();
  toast('Électrificateur placé à votre position.');
});
let energizerOpen = null; // électrificateur affiché dans la fenêtre
function openEnergizer(layer) {
  energizerOpen = layer;
  $('energizer-title').textContent = `⚡ ${nameOf(layer) || 'Électrificateur sans nom'}`;
  const d = here() ? ` · à ${formatLength(here().distanceTo(layer.getLatLng()))} de vous` : '';
  $('energizer-where').innerHTML = fenceNear(layer.getLatLng()) + d;
  $('btn-energizer-move').disabled = !here();
  openDialog('dlg-energizer');
}
$('btn-energizer-move').addEventListener('click', () => {
  if (!energizerOpen || !here()) return;
  energizerOpen.setLatLng(here()); syncLayer(energizerOpen); refresh(); showNearestEnergizer();
  $('dlg-energizer').close(); toast('Électrificateur déplacé à votre position.');
});
$('btn-energizer-rename').addEventListener('click', () => {
  if (!energizerOpen) return;
  const name = prompt('Nom de l\'électrificateur :', nameOf(energizerOpen));
  if (name == null) return;
  if (name.trim()) energizerOpen.feature.properties.name = name.trim(); else delete energizerOpen.feature.properties.name;
  syncLayer(energizerOpen); refresh(); openEnergizer(energizerOpen);
});
$('btn-energizer-delete').addEventListener('click', () => {
  if (!energizerOpen || !confirm('Supprimer cet électrificateur ?')) return;
  drawn.removeLayer(energizerOpen); energizerOpen = null;
  $('dlg-energizer').close(); showNearestEnergizer(); toast('Électrificateur supprimé.');
});

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
  if (!design) openMarksPanel(false);
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
