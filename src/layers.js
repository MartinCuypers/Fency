// Couches cartographiques : fonds de carte (tuiles) et couches de référence (WFS).
// Chaque couche est décrite par une ligne « Clé=valeur;… », par exemple :
//   Type=Wfs;BaseUrl="https://data.geopf.fr/wfs";FeatureTypeName="RPG.2018:parcelles_graphiques"
// Pour en ajouter une, ajoutez une ligne ci-dessous (ou dans VITE_FENCY_LAYERS, séparées par « | »).

export const DEFAULT_LAYERS = [
  'Type=Wmts;Id=ign;Label="Satellite IGN";BaseUrl="https://data.geopf.fr/wmts";LayerName="ORTHOIMAGERY.ORTHOPHOTOS";Style=normal;TileMatrixSet=PM;ImageFormat="image/jpeg";Attribution="© IGN";MaxNativeZoom=19',
  'Type=Xyz;Id=esri;Label="Satellite Esri";Url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";Attribution="Imagery © Esri";MaxNativeZoom=19',
  'Type=Xyz;Id=osm;Label="Plan OSM";Url="https://tile.openstreetmap.org/{z}/{x}/{y}.png";Attribution="© OpenStreetMap";MaxNativeZoom=19',
  'Type=Sentinel;Id=sentinel-savi;Label="Sentinel-2 (SAVI)";BaseUrl="https://services.sentinel-hub.com/ogc/wmts/686364a6-92ae-4aa3-942a-2b249c3c80bc";LayerName="SAVI";ImageFormat="image/jpeg"',
  'Type=Wfs;Id=rpg-2018;Label="Parcelles RPG 2018";BaseUrl="https://data.geopf.fr/wfs";FeatureTypeName="RPG.2018:parcelles_graphiques"',
];

/** « Type=Wfs;BaseUrl="…" » -> { type: 'wfs', baseUrl: '…' } (clés en camelCase, guillemets retirés). */
export function parseLayerSpec(line) {
  const spec = {};
  // découpe sur « ; » hors guillemets
  for (const part of line.match(/(?:[^;"]|"[^"]*")+/g) ?? []) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key) spec[key[0].toLowerCase() + key.slice(1)] = value;
  }
  if (!spec.type) throw new Error(`Couche sans Type : ${line}`);
  spec.type = spec.type.toLowerCase();
  spec.id ??= `${spec.type}-${(spec.layerName ?? spec.featureTypeName ?? spec.url ?? '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  spec.label ??= spec.layerName ?? spec.featureTypeName ?? spec.id;
  return spec;
}

/** Couches par défaut + couches ajoutées à la compilation (VITE_FENCY_LAYERS). */
export function loadLayerSpecs(extra = '') {
  const lines = [...DEFAULT_LAYERS, ...String(extra || '').split('|').map((s) => s.trim()).filter(Boolean)];
  const byId = new Map();
  for (const line of lines) {
    try { const s = parseLayerSpec(line); byId.set(s.id, s); } catch (e) { console.warn('[fency]', e.message); }
  }
  const all = [...byId.values()];
  return { basemaps: all.filter((s) => s.type !== 'wfs'), reference: all.filter((s) => s.type === 'wfs') };
}

/** Modèle d'URL de tuiles (pour L.tileLayer) d'un fond de carte. */
export function tileUrl(spec) {
  if (spec.type === 'xyz') return spec.url;
  const q = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v}`).join('&');
  const sep = spec.baseUrl.includes('?') ? '&' : '?';
  if (spec.type === 'wmts') {
    return spec.baseUrl + sep + q({
      SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0', LAYER: spec.layerName, STYLE: spec.style ?? 'normal',
      FORMAT: spec.imageFormat ?? 'image/png', TILEMATRIXSET: spec.tileMatrixSet ?? 'PM',
    }) + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
  }
  if (spec.type === 'sentinel') {
    // Sentinel Hub : WMTS en paramètres, grille Web Mercator standard en tuiles de 256 px.
    return spec.baseUrl + sep + q({
      SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0', LAYER: spec.layerName, STYLE: spec.style ?? 'default',
      FORMAT: spec.imageFormat ?? 'image/jpeg', TILEMATRIXSET: spec.tileMatrixSet ?? 'PopularWebMercator256',
      TIME: spec.time, MAXCC: spec.maxCloudCover,
    }) + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
  }
  throw new Error(`Type de fond inconnu : ${spec.type}`);
}

export function tileOptions(spec) {
  const sentinel = spec.type === 'sentinel';
  return {
    attribution: spec.attribution ?? (sentinel ? 'Sentinel-2 © Copernicus, Sentinel Hub' : ''),
    maxNativeZoom: Number(spec.maxNativeZoom ?? (sentinel ? 16 : 19)), // Sentinel-2 : 10 m par pixel
    minZoom: Number(spec.minZoom ?? 0),
  };
}

// ------------------------------------------------------------------ WFS
/**
 * Variantes de filtre BBOX. Selon les serveurs, EPSG:4326 se lit « latitude, longitude »
 * (norme WFS 2.0, forme URN) ou « longitude, latitude » (forme courte). On essaie dans
 * cet ordre et on retient la première qui renvoie des objets.
 */
export const BBOX_VARIANTS = ['urn-latlon', 'short-lonlat', 'short-latlon'];

/** URL GetFeature (GeoJSON) pour l'emprise [ouest, sud, est, nord]. */
export function wfsUrl(spec, [w, s, e, n], { variant = BBOX_VARIANTS[0], count = 1500 } = {}) {
  const f = (x) => x.toFixed(6);
  const bbox = {
    'urn-latlon': `${f(s)},${f(w)},${f(n)},${f(e)},urn:ogc:def:crs:EPSG::4326`,
    'short-lonlat': `${f(w)},${f(s)},${f(e)},${f(n)},EPSG:4326`,
    'short-latlon': `${f(s)},${f(w)},${f(n)},${f(e)},EPSG:4326`,
  }[variant];
  const p = new URLSearchParams({
    SERVICE: 'WFS', VERSION: spec.version ?? '2.0.0', REQUEST: 'GetFeature', TYPENAMES: spec.featureTypeName,
    OUTPUTFORMAT: spec.outputFormat ?? 'application/json', SRSNAME: 'EPSG:4326', COUNT: String(count), BBOX: bbox,
  });
  return spec.baseUrl + (spec.baseUrl.includes('?') ? '&' : '?') + p.toString();
}

const mapCoords = (c, fn) => (typeof c[0] === 'number' ? fn(c) : c.map((x) => mapCoords(x, fn)));
const firstCoord = (c) => (typeof c[0] === 'number' ? c : firstCoord(c[0]));

/**
 * Nettoie une réponse WFS : ne garde que les polygones et remet les coordonnées en
 * [longitude, latitude] si le serveur les a renvoyées en [latitude, longitude]
 * (détecté en comparant à l'emprise demandée).
 */
export function normalizeWfs(fc, [w, s, e, n]) {
  const feats = (fc?.features ?? []).filter((f) => f?.geometry && ['Polygon', 'MultiPolygon'].includes(f.geometry.type));
  if (!feats.length) return [];
  const padLon = Math.max(e - w, 0.01) * 3, padLat = Math.max(n - s, 0.01) * 3;
  const inside = ([x, y]) => x >= w - padLon && x <= e + padLon && y >= s - padLat && y <= n + padLat;
  let lonLat = 0, latLon = 0;
  for (const f of feats.slice(0, 20)) {
    const c = firstCoord(f.geometry.coordinates);
    if (inside(c)) lonLat++; else if (inside([c[1], c[0]])) latLon++;
  }
  const swap = latLon > lonLat;
  return feats.map((f, i) => ({
    type: 'Feature', id: f.id ?? `f${i}`, properties: f.properties ?? {},
    geometry: { type: f.geometry.type, coordinates: swap ? mapCoords(f.geometry.coordinates, ([a, b]) => [b, a]) : f.geometry.coordinates },
  }));
}

/** Contour extérieur du polygone d'un objet qui contient le point cliqué (ou le plus grand). */
export function outerRingAt(feature, [lon, lat]) {
  const polys = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const contains = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const hit = polys.find((p) => contains(p[0])) ?? polys.reduce((a, b) => (b[0].length > a[0].length ? b : a));
  return hit[0];
}
