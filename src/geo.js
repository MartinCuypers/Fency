// Géométrie métrique locale (projection équirectangulaire autour d'un point de référence).
// Précision largement suffisante à l'échelle d'une parcelle (quelques centaines de mètres).
const R = 6371008.8;
const RAD = Math.PI / 180;

export function makeProjection([lon0, lat0]) {
  const cos = Math.cos(lat0 * RAD);
  return {
    toXY: ([lon, lat]) => [(lon - lon0) * RAD * R * cos, (lat - lat0) * RAD * R],
    toLL: ([x, y]) => [lon0 + x / (R * cos) / RAD, lat0 + y / R / RAD],
  };
}

export function centroidLL(coords) {
  const n = coords.length;
  return [coords.reduce((s, c) => s + c[0], 0) / n, coords.reduce((s, c) => s + c[1], 0) / n];
}

/** Retire le point de fermeture dupliqué d'un anneau GeoJSON. */
export function openRing(ring) {
  const a = ring[0], b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? ring.slice(0, -1) : ring.slice();
}

export function polygonAreaXY(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function polylineLengthXY(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

export function lengthLL(coords) {
  const p = makeProjection(coords[0]);
  return polylineLengthXY(coords.map(p.toXY));
}

export function areaLL(ring) {
  const r = openRing(ring);
  const p = makeProjection(centroidLL(r));
  return polygonAreaXY(r.map(p.toXY));
}

/** Cap (gisement) en degrés, 0 = nord, sens horaire, de A vers B (plan local en mètres). */
export function bearingXY([x1, y1], [x2, y2]) {
  return ((Math.atan2(x2 - x1, y2 - y1) / RAD) + 360) % 360;
}

/** Cap du plus long côté d'un polygone (pour aligner les clôtures dessus). */
export function longestEdgeBearing(ring) {
  const r = openRing(ring);
  const p = makeProjection(centroidLL(r));
  const pts = r.map(p.toXY);
  let best = 0, bearing = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) { best = l; bearing = bearingXY(a, b); }
  }
  return Math.round(bearing) % 180;
}

export const formatArea = (m2) => (m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} ha` : `${Math.round(m2)} m²`);
export const formatLength = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
