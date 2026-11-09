// Guidage le long d'une clôture : écart latéral, distance restante, piquets à poser.
import { makeProjection } from './geo.js';

export function prepareLine(coords) {
  const proj = makeProjection(coords[0]);
  const pts = coords.map(proj.toXY);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { proj, pts, cum, length: cum[cum.length - 1] };
}

/**
 * Position d'un point GPS par rapport à la ligne.
 * along : distance depuis le début de la ligne ; cross : écart latéral signé,
 * positif quand on est à DROITE du sens de la ligne (il faut donc corriger vers la gauche).
 */
export function locate(line, ll) {
  const [px, py] = line.proj.toXY(ll);
  let best = null;
  for (let i = 0; i + 1 < line.pts.length; i++) {
    const [ax, ay] = line.pts[i], [bx, by] = line.pts[i + 1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const qx = ax + t * dx, qy = ay + t * dy;
    const dist = Math.hypot(px - qx, py - qy);
    if (!best || dist < best.dist) {
      const side = dx * (py - ay) - dy * (px - ax); // >0 : à gauche
      best = { dist, along: line.cum[i] + t * Math.sqrt(len2), cross: side > 0 ? -dist : dist };
    }
  }
  return best;
}

export function pointAt(line, s) {
  const d = Math.max(0, Math.min(line.length, s));
  let i = 0;
  while (i < line.pts.length - 2 && line.cum[i + 1] < d) i++;
  const seg = line.cum[i + 1] - line.cum[i] || 1;
  const t = (d - line.cum[i]) / seg;
  const [ax, ay] = line.pts[i], [bx, by] = line.pts[i + 1];
  return line.proj.toLL([ax + t * (bx - ax), ay + t * (by - ay)]);
}

/** Distances (m) des piquets le long de la ligne, extrémité finale comprise. */
export function postPositions(length, spacing) {
  const out = [];
  for (let s = 0; s < length - spacing * 0.25; s += spacing) out.push(s);
  out.push(length);
  return out;
}

/** Estimation de matériel pour un ensemble de lignes. */
export function estimateMaterial(lengths, { spacing = 10, rows = 1 } = {}) {
  const total = lengths.reduce((s, l) => s + l, 0);
  const posts = lengths.reduce((s, l) => s + postPositions(l, spacing).length, 0);
  return { total, posts, wire: total * rows };
}
