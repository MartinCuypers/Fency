// Génération de clôtures de subdivision (pâturage au fil avant / paddocks) dans un champ.
import { makeProjection, centroidLL, openRing, polygonAreaXY } from './geo.js';

const RAD = Math.PI / 180;

/** Segments d'intersection de la droite v = c avec le polygone (coordonnées u,v). */
function chords(poly, c) {
  const us = [];
  for (let i = 0; i < poly.length; i++) {
    const [u1, v1] = poly[i], [u2, v2] = poly[(i + 1) % poly.length];
    if ((v1 <= c && c < v2) || (v2 <= c && c < v1)) us.push(u1 + ((c - v1) / (v2 - v1)) * (u2 - u1));
  }
  us.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < us.length; i += 2) out.push([us[i], us[i + 1]]);
  return out;
}

const chordLength = (poly, c) => chords(poly, c).reduce((s, [a, b]) => s + (b - a), 0);

/**
 * Découpe un champ en bandes parallèles.
 * @param ring   anneau GeoJSON [[lon,lat],...]
 * @param opts.bearing  direction des clôtures (0 = nord, sens horaire)
 * @param opts.mode     'width' (largeur de bande en m) ou 'area' (surface cible par bande en m²)
 * @param opts.value    largeur (m) ou surface (m²)
 * @param opts.reverse  balaye le champ en sens inverse (choix du côté de départ)
 * @returns {lines:[{coords,length,strip}], strips:[{index,area}], totalArea}
 */
export function generateStrips(ring, { bearing = 0, mode = 'width', value = 20, reverse = false } = {}) {
  const r = openRing(ring);
  if (r.length < 3 || !(value > 0)) return { lines: [], strips: [], totalArea: 0 };
  const proj = makeProjection(centroidLL(r));
  const xy = r.map(proj.toXY);
  const totalArea = polygonAreaXY(xy);

  // Repère (u,v) : les clôtures sont les droites v = const, de direction u.
  const phi = (90 - bearing + (reverse ? 180 : 0)) * RAD;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const toUV = ([x, y]) => [x * cos + y * sin, -x * sin + y * cos];
  const fromUV = ([u, v]) => [u * cos - v * sin, u * sin + v * cos];
  const poly = xy.map(toUV);
  const vmin = Math.min(...poly.map((p) => p[1]));
  const vmax = Math.max(...poly.map((p) => p[1]));

  // Surface cumulée A(v) par intégration numérique (règle du point milieu).
  const N = 4000, dv = (vmax - vmin) / N;
  const cum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) cum[i + 1] = cum[i] + chordLength(poly, vmin + (i + 0.5) * dv) * dv;
  const vAtArea = (a) => {
    let lo = 0, hi = N;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] < a) lo = mid; else hi = mid; }
    const span = cum[hi] - cum[lo] || 1;
    return vmin + (lo + (a - cum[lo]) / span) * dv;
  };

  const cuts = [];
  const eps = Math.max(dv * 2, 0.5);
  if (mode === 'area') {
    for (let k = 1; k * value < cum[N] - 1; k++) cuts.push(vAtArea(k * value));
  } else {
    for (let v = vmin + value; v < vmax - eps; v += value) cuts.push(v);
  }

  const areaBelow = (v) => cum[Math.max(0, Math.min(N, Math.round((v - vmin) / dv)))];
  const bounds = [vmin, ...cuts, vmax];
  const strips = bounds.slice(1).map((v, i) => ({ index: i + 1, area: areaBelow(v) - areaBelow(bounds[i]) }));

  const lines = [];
  cuts.forEach((c, i) => {
    for (const [u1, u2] of chords(poly, c)) {
      const coords = [fromUV([u1, c]), fromUV([u2, c])].map(proj.toLL);
      lines.push({ coords, length: u2 - u1, strip: i + 1 });
    }
  });
  return { lines, strips, totalArea };
}
