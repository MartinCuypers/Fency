// Opérations sur les parcelles : fusion et découpe. Chargé à la demande (bibliothèques
// de géométrie). Les contours sont des anneaux [[lon, lat], …] ; les trous sont ignorés.
import { union, difference } from 'polyclip-ts';
import { buffer } from '@turf/buffer';
import { makeProjection, centroidLL, openRing, polygonAreaXY } from './geo.js';

const close = (ring) => { const r = openRing(ring); return [...r, r[0]]; };
const asPolys = (multi) => multi.map((poly) => poly[0]); // contours extérieurs
const toFeature = (multi) => ({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: multi } });

/** Dilatation (d > 0) ou érosion (d < 0) en mètres ; renvoie des coordonnées MultiPolygon. */
function offset(multi, d) {
  if (!multi.length) return [];
  const out = buffer(toFeature(multi), d, { units: 'meters', steps: 6 });
  if (!out?.geometry) return [];
  return out.geometry.type === 'Polygon' ? [out.geometry.coordinates] : out.geometry.coordinates;
}
/** Fermeture morphologique : comble les creux et interstices plus étroits que 2 × tol. */
const closing = (multi, tol) => offset(offset(multi, tol), -tol);

/** Simplification de Douglas-Peucker (tolérance en mètres) d'un anneau fermé. */
function simplifyRing(ring, tol) {
  const open = openRing(ring);
  if (open.length < 5) return close(open);
  const proj = makeProjection(centroidLL(open));
  const pts = open.map(proj.toXY);
  // point de départ : sommet le plus éloigné du premier, pour couper l'anneau en deux lignes
  let far = 0, fd = -1;
  pts.forEach((p, i) => { const d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]); if (d > fd) { fd = d; far = i; } });
  const dp = (a, b, keep) => {
    let worst = -1, wd = tol;
    const [ax, ay] = pts[a % pts.length], [bx, by] = pts[b % pts.length], len = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i % pts.length];
      const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst >= 0) { dp(a, worst, keep); keep.add(worst % pts.length); dp(worst, b, keep); }
  };
  const keep = new Set([0, far]);
  dp(0, far, keep); dp(far, pts.length, keep);
  return close(open.filter((_, i) => keep.has(i)));
}

const ringAreaM2 = (ring) => {
  const r = openRing(ring), proj = makeProjection(centroidLL(r));
  return polygonAreaXY(r.map(proj.toXY));
};

/**
 * Fusionne des parcelles en une seule.
 * Deux parcelles voisines sont rarement jointives (chemin, haie, imprécision du tracé) :
 * si l'union exacte laisse plusieurs morceaux, on comble les interstices de moins de
 * `gap` mètres ENTRE parcelles, sans toucher au reste de leurs contours.
 * Les calculs se font en mètres arrondis au millimètre : des arêtes presque confondues
 * mettent sinon en échec les opérations booléennes.
 * @returns {{ring: number[][], bridged: boolean}|null}  null si elles sont trop éloignées
 */
export function mergeParcels(rings, { gap = 5 } = {}) {
  const proj = makeProjection(centroidLL(rings.flatMap(openRing)));
  const snap = ([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
  const toM = (multi) => multi.map((poly) => poly.map((ring) => dedupe(ring.map((p) => snap(proj.toXY(p))))).filter((r) => r.length >= 4)).filter((p) => p.length);
  const toLL = (ring) => ring.map(proj.toLL);
  const closingM = (multiM, tol) => toM(closing(multiM.map((poly) => poly.map(toLL)), tol));
  const areaM = (ring) => polygonAreaXY(ring.slice(0, -1));

  const polys = toM(rings.map((r) => [close(r)]));
  if (polys.length < 2) return null;
  let merged, bridged = false;
  try { merged = union(polys[0], ...polys.slice(1)); } catch { return null; }
  if (merged.length > 1 && gap > 0) {
    const tol = gap / 2;
    bridged = true;
    const all = closingM(merged, tol);
    try {
      // interstices = fermeture de l'ensemble, moins la fermeture de chaque parcelle seule
      const each = polys.map((p) => closingM([p], tol)).filter((m) => m.length);
      const gaps = each.length ? difference(all, ...each) : all;
      // La fermeture laisse une encoche arrondie aux extrémités de chaque interstice :
      // on le remplace par son enveloppe convexe, ce qui donne un raccord droit.
      const fills = asPolys(gaps).filter((r) => areaM(r) > 0.05).map((r) => [hull(r)]);
      merged = fills.length ? union(merged, ...fills) : merged;
    } catch {
      // repli : fermeture globale (arrondit légèrement les angles rentrants)
      try { merged = union(merged, all); } catch { return null; }
    }
  }
  const outers = asPolys(merged).map((r) => [areaM(r), r]).sort((a, b) => b[0] - a[0]);
  if (!outers.length) return null;
  // de minuscules éclats peuvent subsister : les ignorer ; au-delà, les parcelles sont disjointes
  const total = polys.reduce((sum, p) => sum + areaM(p[0]), 0);
  if (outers.length > 1 && outers[0][0] < total * 0.999) return null;
  const ring = toLL(outers[0][1]);
  return { ring: bridged ? simplifyRing(ring, 0.02) : ring, bridged };
}

/** Enveloppe convexe (chaîne monotone d'Andrew) d'un anneau, renvoyée fermée. */
function hull(ring) {
  const pts = [...ring].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const h = [];
    for (const p of list) { while (h.length >= 2 && cross(h.at(-2), h.at(-1), p) <= 0) h.pop(); h.push(p); }
    return h.slice(0, -1);
  };
  const out = [...half(pts), ...half(pts.reverse())];
  return [...out, out[0]];
}

/** Retire les points consécutifs identiques d'un anneau fermé. */
function dedupe(ring) {
  const out = ring.filter((p, i) => i === 0 || p[0] !== ring[i - 1][0] || p[1] !== ring[i - 1][1]);
  if (out.length && (out[0][0] !== out.at(-1)[0] || out[0][1] !== out.at(-1)[1])) out.push(out[0]);
  return out;
}

/**
 * Coupe une parcelle le long d'une ligne (qui doit la traverser de part en part).
 * Le trait de coupe fait 1 mm de large. @returns {number[][][]} contours des morceaux (≥ 2) ou []
 */
export function splitParcel(ring, line, { extend = 1, halfWidth = 0.0005, minArea = 0.01 } = {}) {
  if (line.length < 2) return [];
  const proj = makeProjection(centroidLL(openRing(ring)));
  const poly = close(ring).map(proj.toXY);
  const pts = line.map(proj.toXY);
  // prolonger un peu les extrémités : tolère une ligne arrêtée juste avant la limite
  const stretch = (a, b) => { const l = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; return [a[0] + ((a[0] - b[0]) / l) * extend, a[1] + ((a[1] - b[1]) / l) * extend]; };
  pts[0] = stretch(pts[0], pts[1]);
  pts[pts.length - 1] = stretch(pts[pts.length - 1], pts[pts.length - 2]);
  // bande très fine autour de la ligne
  const left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / l, ny = (b[0] - a[0]) / l;
    left.push([pts[i][0] + nx * halfWidth, pts[i][1] + ny * halfWidth]);
    right.push([pts[i][0] - nx * halfWidth, pts[i][1] - ny * halfWidth]);
  }
  const strip = [...left, ...right.reverse()]; strip.push(strip[0]);
  const pieces = asPolys(difference([poly], [strip])).filter((r) => polygonAreaXY(r.slice(0, -1)) >= minArea);
  if (pieces.length < 2) return [];
  return pieces.map((r) => r.map(proj.toLL));
}
