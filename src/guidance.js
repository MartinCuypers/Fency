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

/** Estimation de matériel pour un ensemble de lignes : longueur de clôture et de fil. */
export function estimateMaterial(lengths, { rows = 1 } = {}) {
  const total = lengths.reduce((s, l) => s + l, 0);
  return { total, wire: total * rows };
}

/** Distance (m) et cap (0 = nord, sens horaire) depuis une position vers le départ de la ligne. */
export function toStart(line, ll) {
  const [x, y] = line.proj.toXY(ll); // le départ est l'origine du repère de la ligne
  return { dist: Math.hypot(x, y), bearing: (Math.atan2(-x, -y) * 180 / Math.PI + 360) % 360 };
}

/** Cap de la ligne (sens de pose) à la distance `along` de son départ. */
export function bearingAt(line, along) {
  let i = 0;
  while (i < line.pts.length - 2 && line.cum[i + 1] <= along) i++;
  const [ax, ay] = line.pts[i], [bx, by] = line.pts[i + 1];
  return (Math.atan2(bx - ax, by - ay) * 180 / Math.PI + 360) % 360;
}

/**
 * Guidage en deux étapes.
 *   'approach' : rejoindre le départ de la clôture (flèche et distance) ;
 *   'lay'      : poser la clôture en restant sur la ligne ;
 *   'done'     : arrivée au bout.
 * @param {string|null} phase  étape courante (null : à déterminer)
 * @param {{distStart: number, cross: number, along: number, length: number, accuracy?: number}} s
 */
export function nextPhase(phase, { distStart, cross, along, length, accuracy = 0 }) {
  // rayon d'arrivée : au moins 3 m, élargi quand le GPS est imprécis (sans dépasser 8 m)
  const reach = Math.min(8, Math.max(3, accuracy * 1.5));
  if (phase == null) {
    // au lancement : déjà engagé le long de la clôture -> on reprend la pose là où l'on est
    const engaged = Math.abs(cross) <= reach && along > 1 && along < length - 1;
    return engaged || distStart <= reach ? 'lay' : 'approach';
  }
  if (phase === 'approach') return distStart <= reach ? 'lay' : 'approach';
  if (phase === 'lay') return along >= length - 0.3 && Math.abs(cross) <= reach ? 'done' : 'lay';
  return phase;
}

/** Extrémité la plus proche d'une position : vrai s'il vaut mieux partir de la fin de la ligne. */
export function nearerEndIsLast(coords, ll) {
  const proj = makeProjection(ll);
  const d = (c) => Math.hypot(...proj.toXY(c));
  return d(coords[coords.length - 1]) < d(coords[0]);
}
