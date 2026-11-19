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

/** Retire des intervalles [a, b] les parties couvertes par d'autres intervalles (qui peuvent se chevaucher). */
function subtract(spans, holes) {
  if (!holes.length) return spans;
  holes.sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const span of spans) {
    let [a, b] = span;
    for (const [h1, h2] of holes) {
      if (h2 <= a || h1 >= b) continue;
      if (h1 > a) out.push([a, h1]);
      a = Math.max(a, h2);
      if (a >= b) break;
    }
    if (a < b) out.push([a, b]);
  }
  return out;
}

/**
 * Découpe un champ en bandes parallèles.
 * @param ring   anneau GeoJSON [[lon,lat],...]
 * @param opts.bearing  direction des clôtures (0 = nord, sens horaire)
 * @param opts.mode     'width' (largeur de bande en m) ou 'area' (surface cible par bande en m²)
 * @param opts.value    largeur (m) ou surface (m²)
 * @param opts.reverse  balaye le champ en sens inverse (choix du côté de départ)
 * @param opts.holes    obstacles : anneaux [[lon,lat],...] exclus des bandes (surfaces et clôtures)
 * @param opts.offset   décalage des lignes en mètres (mode 'width' seulement), dans le sens du balayage
 * @returns {lines:[{coords,length,strip}], strips:[{index,area}], totalArea} (surfaces hors obstacles)
 */
export function generateStrips(ring, { bearing = 0, mode = 'width', value = 20, reverse = false, holes = [], offset = 0 } = {}) {
  const r = openRing(ring);
  if (r.length < 3 || !(value > 0)) return { lines: [], strips: [], totalArea: 0 };
  const proj = makeProjection(centroidLL(r));
  const xy = r.map(proj.toXY);

  // Repère (u,v) : les clôtures sont les droites v = const, de direction u.
  const phi = (90 - bearing + (reverse ? 180 : 0)) * RAD;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const toUV = ([x, y]) => [x * cos + y * sin, -x * sin + y * cos];
  const fromUV = ([u, v]) => [u * cos - v * sin, u * sin + v * cos];
  const poly = xy.map(toUV);
  const holesUV = holes.map(openRing).filter((h) => h.length >= 3).map((h) => h.map((ll) => toUV(proj.toXY(ll))));
  // parties utiles de la droite v = c : dans le champ, hors des obstacles
  const usable = (c) => subtract(chords(poly, c), holesUV.flatMap((h) => chords(h, c)));
  const chordLength = (c) => usable(c).reduce((s, [a, b]) => s + (b - a), 0);
  const vmin = Math.min(...poly.map((p) => p[1]));
  const vmax = Math.max(...poly.map((p) => p[1]));

  // Surface cumulée A(v) par intégration numérique (règle du point milieu).
  const N = 4000, dv = (vmax - vmin) / N;
  const cum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) cum[i + 1] = cum[i] + chordLength(vmin + (i + 0.5) * dv) * dv;
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
    const o = ((offset % value) + value) % value; // décalage ramené dans [0, largeur)
    for (let v = vmin + (o > eps ? o : value); v < vmax - eps; v += value) cuts.push(v);
  }

  const areaBelow = (v) => cum[Math.max(0, Math.min(N, Math.round((v - vmin) / dv)))];
  const bounds = [vmin, ...cuts, vmax];
  const strips = bounds.slice(1).map((v, i) => ({ index: i + 1, area: areaBelow(v) - areaBelow(bounds[i]) }));

  const lines = [];
  cuts.forEach((c, i) => {
    for (const [u1, u2] of usable(c)) {
      if (u2 - u1 < 0.5) continue; // morceau négligeable entre deux obstacles
      const coords = [fromUV([u1, c]), fromUV([u2, c])].map(proj.toLL);
      lines.push({ coords, length: u2 - u1, strip: i + 1 });
    }
  });
  return { lines, strips, totalArea: holesUV.length ? cum[N] : polygonAreaXY(xy) };
}

/** Longueur de la clôture en L qui ferme un paddock du quadrillage (fixée par l'enrouleur Kiwitech). */
export const L_FENCE = 280;

/**
 * Quadrillage de repères : lignes principales et, en option, lignes secondaires d'une autre direction.
 * Les croisements sont insérés comme sommets des lignes : ils deviennent des points d'accroche.
 * @param primary   options de generateStrips pour les lignes principales
 * @param secondary options de generateStrips pour les lignes secondaires (ou null)
 * @returns {lines, strips, totalArea, secondary: [{coords,length,strip}]}
 */
export function generateGrid(ring, { primary, secondary = null, holes = [] }) {
  const a = generateStrips(ring, { ...primary, holes });
  if (!secondary) return { ...a, secondary: [] };
  const b = generateStrips(ring, { ...secondary, holes });
  const r = openRing(ring);
  if (r.length >= 3) insertCrossings(a.lines, b.lines, makeProjection(centroidLL(r)));
  return { ...a, secondary: b.lines };
}

/** Ajoute aux lignes (segments de 2 points) les points où elles se croisent. */
function insertCrossings(as, bs, proj) {
  const xyA = as.map((l) => l.coords.map(proj.toXY)), xyB = bs.map((l) => l.coords.map(proj.toXY));
  const cutsA = as.map(() => []), cutsB = bs.map(() => []);
  xyA.forEach(([p, p2], i) => xyB.forEach(([q, q2], j) => {
    const rx = p2[0] - p[0], ry = p2[1] - p[1], sx = q2[0] - q[0], sy = q2[1] - q[1];
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-9) return; // parallèles
    const t = ((q[0] - p[0]) * sy - (q[1] - p[1]) * sx) / den, u = ((q[0] - p[0]) * ry - (q[1] - p[1]) * rx) / den;
    if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return;
    const x = [p[0] + t * rx, p[1] + t * ry];
    cutsA[i].push([t, x]); cutsB[j].push([u, x]);
  }));
  const rebuild = (lines, cuts) => lines.forEach((l, i) => {
    if (!cuts[i].length) return;
    const pts = cuts[i].sort((m, n) => m[0] - n[0]).map(([, x]) => proj.toLL(x));
    l.coords = [l.coords[0], ...pts, l.coords[1]];
  });
  rebuild(as, cutsA); rebuild(bs, cutsB);
}

/**
 * Paddocks d'un quadrillage : espacements a (entre lignes principales) et b (entre secondaires),
 * angle entre les deux directions. Renvoie la surface d'un paddock et la longueur de la clôture en L.
 */
export function paddockOf(a, b, angleDeg) {
  const s = Math.abs(Math.sin(angleDeg * Math.PI / 180)) || 1e-9;
  return { area: (a * b) / s, lFence: (a + b) / s };
}

/**
 * Espacements (a, b) donnant des paddocks de surface `area` (m²) fermés par une clôture en L de
 * longueur `length`, pour un angle donné entre les familles. `near` : valeur de a souhaitée (choix
 * de la solution). Renvoie null si la surface est trop grande, avec la surface maximale possible.
 */
export function fitPaddock(area, angleDeg, { length = L_FENCE, near = 0 } = {}) {
  const s = Math.abs(Math.sin(angleDeg * Math.PI / 180));
  if (s < 0.05) return { fit: null, maxArea: 0 };
  const sum = length * s, prod = area * s, disc = sum * sum - 4 * prod;
  const maxArea = (sum * sum) / (4 * s);
  if (disc < 0 || !(area > 0)) return { fit: null, maxArea };
  const r1 = (sum + Math.sqrt(disc)) / 2, r2 = (sum - Math.sqrt(disc)) / 2;
  const a = Math.abs(r1 - near) <= Math.abs(r2 - near) ? r1 : r2;
  return { fit: { a, b: sum - a }, maxArea };
}
