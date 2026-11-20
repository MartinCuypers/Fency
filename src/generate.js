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
  return {
    lines, strips, totalArea: holesUV.length ? cum[N] : polygonAreaXY(xy),
    // pour placer d'autres lignes bande par bande : limites des bandes (v) et position v d'un point x,y
    bounds, proj, vOf: (p) => toUV(p)[1],
  };
}

/** Longueur de la clôture en L qui ferme un paddock du quadrillage (fixée par l'enrouleur Kiwitech). */
export const L_FENCE = 280;

/**
 * Quadrillage de repères : lignes principales et, en option, lignes secondaires d'une autre direction.
 * Les croisements sont insérés comme sommets des lignes : ils deviennent des points d'accroche.
 * @param primary   options de generateStrips pour les lignes principales
 * @param secondary options de generateStrips pour les lignes secondaires (ou null), plus :
 *   - spacingFor(a) : si présent, lignes placées bande par bande, avec un espacement propre à chaque
 *     bande principale de largeur a (null : pas de ligne secondaire dans cette bande)
 * @returns {lines, strips, totalArea, secondary: [{coords,length,strip}], paddocks: [{strip,width,spacing,lines}]}
 */
export function generateGrid(ring, { primary, secondary = null, holes = [] }) {
  const a = generateStrips(ring, { ...primary, holes });
  const out = { lines: a.lines, strips: a.strips, totalArea: a.totalArea, secondary: [], paddocks: [] };
  if (!secondary || !a.proj) return out;
  if (!secondary.spacingFor) {
    out.secondary = generateStrips(ring, { ...secondary, holes }).lines;
  } else {
    const cache = new Map(); // même espacement, mêmes lignes : on ne les calcule qu'une fois
    for (let i = 0; i + 1 < a.bounds.length; i++) {
      const v0 = a.bounds[i], v1 = a.bounds[i + 1], width = v1 - v0;
      const spacing = secondary.spacingFor(width);
      const pad = { strip: i + 1, width, spacing, lines: 0 };
      out.paddocks.push(pad);
      if (!(spacing > 0)) continue;
      const key = spacing.toFixed(3);
      if (!cache.has(key)) cache.set(key, generateStrips(ring, { ...secondary, value: spacing, holes }).lines);
      for (const l of cache.get(key)) {
        const seg = clipToBand(l.coords.map(a.proj.toXY), a.vOf, v0, v1);
        if (seg) pad.lines++;
        if (seg) out.secondary.push({ coords: seg.map(a.proj.toLL), length: Math.hypot(seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]), strip: l.strip, band: i + 1 });
      }
    }
  }
  insertCrossings(out.lines, out.secondary, a.proj);
  return out;
}

/** Partie d'un segment [P, Q] (coordonnées x,y) comprise entre les droites v = v0 et v = v1. */
function clipToBand([P, Q], vOf, v0, v1) {
  const vp = vOf(P), vq = vOf(Q);
  let t0 = 0, t1 = 1;
  if (Math.abs(vq - vp) < 1e-9) { if (vp < v0 || vp > v1) return null; } else {
    const ta = (v0 - vp) / (vq - vp), tb = (v1 - vp) / (vq - vp);
    t0 = Math.max(0, Math.min(ta, tb)); t1 = Math.min(1, Math.max(ta, tb));
  }
  if (t1 - t0 < 1e-6) return null;
  const at = (t) => [P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])];
  const seg = [at(t0), at(t1)];
  return Math.hypot(seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]) < 0.5 ? null : seg;
}

/**
 * Ajoute aux lignes (segments de 2 points) les points où elles se croisent. Une ligne secondaire
 * qui s'arrête sur une ligne principale y ajoute aussi un sommet (sur la principale seulement).
 */
function insertCrossings(as, bs, proj) {
  const xyA = as.map((l) => l.coords.map(proj.toXY)), xyB = bs.map((l) => l.coords.map(proj.toXY));
  const cutsA = as.map(() => []), cutsB = bs.map(() => []);
  const E = 1e-6;
  xyA.forEach(([p, p2], i) => xyB.forEach(([q, q2], j) => {
    const rx = p2[0] - p[0], ry = p2[1] - p[1], sx = q2[0] - q[0], sy = q2[1] - q[1];
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-9) return; // parallèles
    const t = ((q[0] - p[0]) * sy - (q[1] - p[1]) * sx) / den, u = ((q[0] - p[0]) * ry - (q[1] - p[1]) * rx) / den;
    if (t <= E || t >= 1 - E || u < -1e-4 || u > 1 + 1e-4) return;
    const x = [p[0] + t * rx, p[1] + t * ry];
    cutsA[i].push([t, x]);
    if (u > E && u < 1 - E) cutsB[j].push([u, x]);
  }));
  const rebuild = (lines, cuts) => lines.forEach((l, i) => {
    if (!cuts[i].length) return;
    const sorted = cuts[i].sort((m, n) => m[0] - n[0]).filter((c, k, arr) => !k || c[0] - arr[k - 1][0] > 1e-7);
    l.coords = [l.coords[0], ...sorted.map(([, x]) => proj.toLL(x)), l.coords[1]];
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
