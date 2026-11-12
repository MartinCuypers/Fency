import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLayerSpec, loadLayerSpecs, tileUrl, tileOptions, wfsUrl, normalizeWfs, outerRingAt } from '../src/layers.js';
import { mergeParcels, splitParcel } from '../src/parcels.js';
import { makeProjection, areaLL } from '../src/geo.js';

test('description de couche au format « Clé=valeur;… »', () => {
  const s = parseLayerSpec('Type=Sentinel;BaseUrl="https://services.sentinel-hub.com/ogc/wmts/686364a6-92ae-4aa3-942a-2b249c3c80bc";LayerName="SAVI";ImageFormat="image/jpeg"');
  assert.deepEqual([s.type, s.layerName, s.imageFormat], ['sentinel', 'SAVI', 'image/jpeg']);
  assert.equal(s.baseUrl, 'https://services.sentinel-hub.com/ogc/wmts/686364a6-92ae-4aa3-942a-2b249c3c80bc');
  const w = parseLayerSpec('Type=Wfs;BaseUrl="https://data.geopf.fr/wfs";FeatureTypeName="RPG.2018:parcelles_graphiques"');
  assert.deepEqual([w.type, w.featureTypeName, w.label], ['wfs', 'RPG.2018:parcelles_graphiques', 'RPG.2018:parcelles_graphiques']);
  assert.equal(parseLayerSpec('Type=Xyz;Url="https://a/{z}/{x}/{y}.png?k=a;b"').url, 'https://a/{z}/{x}/{y}.png?k=a;b'); // « ; » entre guillemets
  assert.throws(() => parseLayerSpec('BaseUrl="x"'));
});

test('couches par défaut et ajoutées', () => {
  const warn = console.warn; console.warn = () => {};
  const { basemaps, reference } = loadLayerSpecs('Type=Wfs;Id=cad;Label="Cadastre";BaseUrl="https://x/wfs";FeatureTypeName="A:b" | n importe quoi');
  console.warn = warn;
  assert.deepEqual(basemaps.map((b) => b.id), ['ign', 'esri', 'osm', 'sentinel-savi']);
  assert.deepEqual(reference.map((r) => r.id), ['rpg-2018', 'cad']);
});

test('URL des tuiles', () => {
  const { basemaps } = loadLayerSpecs();
  const url = (id) => tileUrl(basemaps.find((b) => b.id === id));
  assert.equal(url('ign'), 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}');
  assert.equal(url('sentinel-savi'), 'https://services.sentinel-hub.com/ogc/wmts/686364a6-92ae-4aa3-942a-2b249c3c80bc?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=SAVI&STYLE=default&FORMAT=image/jpeg&TILEMATRIXSET=PopularWebMercator256&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}');
  assert.match(tileUrl(parseLayerSpec('Type=Sentinel;BaseUrl="https://s/i";LayerName=NDVI;Time="2026-05-01/2026-05-31";MaxCloudCover=20')), /TIME=2026-05-01\/2026-05-31&MAXCC=20/);
  assert.equal(url('osm'), 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.equal(tileOptions(basemaps.find((b) => b.id === 'sentinel-savi')).maxNativeZoom, 16);
});

test('URL WFS : variantes d\'ordre des axes', () => {
  const spec = parseLayerSpec('Type=Wfs;BaseUrl="https://data.geopf.fr/wfs";FeatureTypeName="RPG.2018:parcelles_graphiques"');
  const bounds = [-1.7, 48.09, -1.66, 48.11];
  const u = new URL(wfsUrl(spec, bounds));
  assert.equal(u.searchParams.get('TYPENAMES'), 'RPG.2018:parcelles_graphiques');
  assert.equal(u.searchParams.get('OUTPUTFORMAT'), 'application/json');
  assert.equal(u.searchParams.get('BBOX'), '48.090000,-1.700000,48.110000,-1.660000,urn:ogc:def:crs:EPSG::4326');
  assert.equal(new URL(wfsUrl(spec, bounds, { variant: 'short-lonlat' })).searchParams.get('BBOX'), '-1.700000,48.090000,-1.660000,48.110000,EPSG:4326');
});

test('réponse WFS : filtrage et remise en ordre longitude/latitude', () => {
  const bounds = [-1.7, 48.09, -1.66, 48.11];
  const poly = (coords, extra = {}) => ({ type: 'Feature', properties: { code_cultu: 'PPH' }, geometry: { type: 'Polygon', coordinates: [coords] }, ...extra });
  const lonLat = [[-1.68, 48.1], [-1.679, 48.1], [-1.679, 48.101], [-1.68, 48.1]];
  const latLon = lonLat.map(([a, b]) => [b, a]);
  const fc = (features) => ({ type: 'FeatureCollection', features });
  assert.deepEqual(normalizeWfs(fc([poly(lonLat)]), bounds)[0].geometry.coordinates[0], lonLat);
  assert.deepEqual(normalizeWfs(fc([poly(latLon)]), bounds)[0].geometry.coordinates[0], lonLat, 'axes inversés corrigés');
  const mixed = fc([poly(lonLat, { id: 'p.1' }), { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-1.68, 48.1] } }, { type: 'Feature', geometry: null }]);
  const out = normalizeWfs(mixed, bounds);
  assert.equal(out.length, 1); assert.equal(out[0].id, 'p.1'); assert.equal(out[0].properties.code_cultu, 'PPH');
  assert.deepEqual(normalizeWfs({}, bounds), []);
});

test('polygone cliqué dans un MultiPolygon', () => {
  const sq = (x, y, s = 1) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];
  const f = { geometry: { type: 'MultiPolygon', coordinates: [[sq(0, 0)], [sq(5, 5, 2), sq(5.5, 5.5, 0.2)]] } };
  assert.deepEqual(outerRingAt(f, [6, 6]), sq(5, 5, 2));
  assert.deepEqual(outerRingAt(f, [0.5, 0.5]), sq(0, 0));
});

// --- géométrie des parcelles, en mètres autour d'un point près de Rennes
const P = makeProjection([-1.68, 48.11]);
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]].map(P.toLL);
const area = (ring) => areaLL(ring);

test('fusion : parcelles jointives -> union exacte', () => {
  const m = mergeParcels([rect(0, 0, 100, 50), rect(100, 0, 60, 50)]);
  assert.equal(m.bridged, false);
  assert.ok(Math.abs(area(m.ring) - 8000) < 5, `aire ${area(m.ring)}`);
});

test('fusion : parcelles séparées par un chemin de 3 m -> interstice comblé', () => {
  const m = mergeParcels([rect(0, 0, 100, 50), rect(103, 0, 60, 50)]);
  assert.equal(m.bridged, true);
  const a = area(m.ring);
  assert.ok(Math.abs(a - (5000 + 3000 + 150)) < 25, `aire ${a}`);
  assert.ok(m.ring.length <= 9, `raccord droit : contour simple (${m.ring.length} sommets)`);
});

test('fusion : seul l\'interstice est comblé, les angles rentrants sont conservés', () => {
  // parcelle en L (angle rentrant en (50,50)) + voisine à 2 m
  const L = [[0, 0], [100, 0], [100, 50], [50, 50], [50, 100], [0, 100], [0, 0]].map(P.toLL);
  const m = mergeParcels([L, rect(102, 0, 40, 50)]);
  const a = area(m.ring);
  assert.ok(Math.abs(a - (7500 + 2000 + 100)) < 20, `aire ${a}`); // pas de congé dans l'angle du L
  const corner = P.toLL([50, 50]);
  const dmin = Math.min(...m.ring.map((p) => { const [x, y] = P.toXY(p), [cx, cy] = P.toXY(corner); return Math.hypot(x - cx, y - cy); }));
  assert.ok(dmin < 0.05, `sommet de l'angle rentrant conservé (écart ${dmin.toFixed(3)} m)`);
});

test('fusion : parcelles trop éloignées -> refus ; trois parcelles en chaîne', () => {
  assert.equal(mergeParcels([rect(0, 0, 100, 50), rect(130, 0, 60, 50)]), null);
  const m = mergeParcels([rect(0, 0, 50, 50), rect(51, 0, 50, 50), rect(102, 0, 50, 50)]);
  assert.ok(m && Math.abs(area(m.ring) - (7500 + 100)) < 20, `aire ${m && area(m.ring)}`);
});

test('découpe : ligne traversante -> deux morceaux de même surface totale', () => {
  const field = rect(0, 0, 200, 100);
  const pieces = splitParcel(field, [[80, -5], [80, 105]].map(P.toLL));
  assert.equal(pieces.length, 2);
  const areas = pieces.map(area).sort((a, b) => a - b);
  assert.ok(Math.abs(areas[0] - 8000) < 5 && Math.abs(areas[1] - 12000) < 5, areas.join(' / '));
  assert.ok(Math.abs(areas[0] + areas[1] - 20000) < 1);
});

test('découpe : ligne brisée, ligne arrêtée juste avant le bord, ligne trop courte', () => {
  const field = rect(0, 0, 200, 100);
  assert.equal(splitParcel(field, [[50, -5], [50, 50], [150, 50], [150, 105]].map(P.toLL)).length, 2);
  assert.equal(splitParcel(field, [[80, 0.4], [80, 99.6]].map(P.toLL)).length, 2, 'prolongement des extrémités');
  assert.deepEqual(splitParcel(field, [[80, 20], [80, 60]].map(P.toLL)), [], 'ne traverse pas');
  assert.deepEqual(splitParcel(field, [[300, 0], [300, 100]].map(P.toLL)), [], 'hors parcelle');
  // parcelle en U : une ligne peut donner trois morceaux
  const U = [[0, 0], [150, 0], [150, 100], [100, 100], [100, 40], [50, 40], [50, 100], [0, 100], [0, 0]].map(P.toLL);
  assert.equal(splitParcel(U, [[-5, 70], [155, 70]].map(P.toLL)).length, 3);
});

test('fusion : robustesse sur 400 configurations aléatoires', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let bridged = 0, exact = 0, refused = 0;
  for (let i = 0; i < 400; i++) {
    const ox = (rnd() - 0.5) * 400, oy = (rnd() - 0.5) * 400;
    const w1 = 30 + rnd() * 150, h1 = 30 + rnd() * 100, w2 = 30 + rnd() * 150, h2 = 20 + rnd() * 100;
    const g = [0, 0, 0.3, 1, 2.5, 3, 4.2, 4.9, 8, 15][Math.floor(rnd() * 10)], dy = (rnd() - 0.5) * 20;
    const a = rect(ox - w1 - g, oy, w1, h1), b = rect(ox, oy + dy, w2, h2);
    const overlap = Math.min(oy + h1, oy + dy + h2) - Math.max(oy, oy + dy);
    const m = mergeParcels([a, b]);
    if (g > 5.2) { assert.equal(m, null, `cas ${i} : écart ${g} m`); refused++; continue; }
    assert.ok(m, `cas ${i} : écart ${g} m, fusion attendue`);
    const expected = w1 * h1 + w2 * h2 + g * Math.max(overlap, 0);
    // parcelles décalées : le comblement déborde légèrement en biais près des angles, d'où la marge liée à l'écart
    assert.ok(Math.abs(area(m.ring) - expected) < 3 + 3 * g + expected * 0.0005, `cas ${i} : aire ${area(m.ring).toFixed(1)} / ${expected.toFixed(1)} (écart ${g} m)`);
    if (m.bridged) bridged++; else exact++;
  }
  assert.ok(bridged > 100 && exact > 30 && refused > 30, `${bridged} comblées, ${exact} exactes, ${refused} refusées`);
});

test('découpe : robustesse sur 300 traits aléatoires', () => {
  let seed = 777; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 300; i++) {
    const w = 40 + rnd() * 300, h = 40 + rnd() * 200, field = rect(0, 0, w, h);
    const x1 = rnd() * w, x2 = rnd() * w;
    const pieces = splitParcel(field, [[x1, -3], [x2, h + 3]].map(P.toLL));
    assert.equal(pieces.length, 2, `cas ${i}`);
    assert.ok(Math.abs(pieces.reduce((s, r) => s + area(r), 0) - w * h) < 1 + w * h * 1e-4, `cas ${i} : surface conservée`);
  }
});
