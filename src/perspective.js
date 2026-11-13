// Vue en perspective du sol devant le quad : clôture à suivre et quadrillage métrique.
// Repère « caméra » : x vers la droite, y vers l'avant, z vers le haut, origine = le quad, en mètres.

/**
 * Caméra placée derrière et au-dessus du quad, regardant vers l'avant et vers le bas.
 * @returns {{project: Function, clip: Function, horizonY: number}}
 */
export function makeCamera({ width, height, camHeight = 3, back = 5, pitchDeg = 24, focal = 0.8, horizon = 0.2, near = 0.5 }) {
  const th = (pitchDeg * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
  const F = focal * width, horizonY = horizon * height, cy = horizonY + F * Math.tan(th);
  const depth = ([x, y, z = 0]) => (y + back) * c + (camHeight - z) * s;
  /** Point du monde -> [X, Y] à l'écran, ou null s'il est derrière la caméra. */
  const project = (p) => {
    const d = depth(p);
    if (d < near) return null;
    const v = (p[1] + back) * s + ((p[2] ?? 0) - camHeight) * c;
    return [width / 2 + (F * p[0]) / d, cy - (F * v) / d];
  };
  /** Segment du monde -> segment à l'écran, coupé au plan proche ; null s'il est entièrement derrière. */
  const clip = (a, b) => {
    const da = depth(a), db = depth(b);
    if (da < near && db < near) return null;
    const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, (p[2] ?? 0) + ((q[2] ?? 0) - (p[2] ?? 0)) * t];
    const eps = 1e-6;
    if (da < near) a = lerp(a, b, (near + eps - da) / (db - da));
    else if (db < near) b = lerp(b, a, (near + eps - db) / (da - db));
    const A = project(a), B = project(b);
    return A && B ? [A, B] : null;
  };
  return { project, clip, horizonY, width, height };
}

/**
 * Passe des coordonnées « monde » (est, nord, en mètres, relatives au quad) au repère caméra
 * pour un cap donné (0 = nord, sens horaire).
 */
export function toCameraFrame([e, n], headingDeg) {
  const h = (headingDeg * Math.PI) / 180;
  return [e * Math.cos(h) - n * Math.sin(h), e * Math.sin(h) + n * Math.cos(h)];
}

const COLORS = { ok: '#43a047', warn: '#fb8c00', bad: '#e53935' };

/**
 * Dessine la scène.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} scene
 * @param {number[][]} scene.fence      sommets de la clôture, repère caméra
 * @param {number[]} scene.origin       point de la clôture le plus proche du quad
 * @param {number[]} scene.dir          direction (unitaire) de la clôture en ce point
 * @param {number} scene.along          distance de ce point au départ de la clôture (ancre le quadrillage au sol)
 * @param {'ok'|'warn'|'bad'} scene.level
 * @returns {boolean} vrai si une partie de la clôture est visible à l'écran
 */
export function drawScene(ctx, cam, scene) {
  const { width: w, height: h, horizonY } = cam;
  // ciel et sol
  const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
  sky.addColorStop(0, '#7fb6e6'); sky.addColorStop(1, '#d6e9f8');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, horizonY);
  const ground = ctx.createLinearGradient(0, horizonY, 0, h);
  ground.addColorStop(0, '#6a8f5a'); ground.addColorStop(1, '#3f6b34');
  ctx.fillStyle = ground; ctx.fillRect(0, horizonY, w, h - horizonY);

  const seg = (a, b) => { const s = cam.clip(a, b); if (!s) return false; ctx.moveTo(s[0][0], s[0][1]); ctx.lineTo(s[1][0], s[1][1]); return true; };
  const [ox, oy] = scene.origin, [tx, ty] = scene.dir, nx = ty, ny = -tx; // n : à droite de la clôture
  const at = (s, k, z = 0) => [ox + s * tx + k * nx, oy + s * ty + k * ny, z];

  // quadrillage de 1 m, aligné sur la clôture ; un trait sur cinq est renforcé
  const K = 15, S0 = -12, S1 = 70;
  const mStart = Math.ceil(scene.along + S0), mEnd = Math.floor(scene.along + S1);
  for (const strong of [false, true]) {
    ctx.beginPath();
    for (let k = -K; k <= K; k++) if ((k % 5 === 0) === strong) seg(at(S0, k), at(S1, k));
    for (let m = mStart; m <= mEnd; m++) {
      const s = m - scene.along;
      if ((m % 5 === 0) !== strong) continue;
      if (!strong && Math.abs(s) > 18) continue; // au loin, seuls les traits de 5 m
      seg(at(s, -K), at(s, K));
    }
    ctx.strokeStyle = strong ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.22)';
    ctx.lineWidth = strong ? 1.6 : 1; ctx.stroke();
  }

  // graduations latérales : distance à la clôture, lues sur la rangée située 3 m devant le quad
  if (Math.abs(ty) > 0.35) {
    ctx.font = `600 ${Math.max(11, Math.round(w / 32))}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const k of [-10, -5, -3, -2, -1, 1, 2, 3, 5, 10]) {
      const s = (3 - (oy + k * ny)) / ty, p = cam.project(at(s, k));
      if (!p || p[0] < 14 || p[0] > w - 14 || p[1] > h - 8) continue;
      const label = `${Math.abs(k)} m`, tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(p[0] - tw / 2, p[1] - 9, tw, 18);
      ctx.fillStyle = '#fff'; ctx.fillText(label, p[0], p[1]);
    }
  }

  // clôture : trait épais, bordé de sombre pour rester lisible au soleil
  let visible = false;
  for (const [color, width] of [['rgba(0,0,0,0.55)', 9], [COLORS[scene.level] ?? COLORS.bad, 5]]) {
    ctx.beginPath();
    for (let i = 0; i + 1 < scene.fence.length; i++) {
      const s = cam.clip([...scene.fence[i], 0], [...scene.fence[i + 1], 0]);
      if (!s) continue;
      ctx.moveTo(s[0][0], s[0][1]); ctx.lineTo(s[1][0], s[1][1]);
      const on = (p) => p[0] > -w && p[0] < 2 * w && p[1] > 0 && p[1] < h;
      if ((on(s[0]) || on(s[1])) && Math.max(s[0][1], s[1][1]) > horizonY + 2) visible = true;
    }
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
  }
  // jalons : départ (vert) et arrivée (rouge)
  const pole = (pt, color) => {
    const s = cam.clip([...pt, 0], [...pt, 1.6]);
    if (!s) return;
    ctx.beginPath(); ctx.moveTo(s[0][0], s[0][1]); ctx.lineTo(s[1][0], s[1][1]);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.arc(s[1][0], s[1][1], 6, 0, 2 * Math.PI); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  };
  pole(scene.fence[0], '#2e7d32'); pole(scene.fence.at(-1), '#c62828');

  // le quad : flèche au sol, toujours orientée vers l'avant
  const tri = [[0, 1.1], [-0.55, -0.6], [0, -0.25], [0.55, -0.6]].map((p) => cam.project([...p, 0]));
  if (tri.every(Boolean)) {
    ctx.beginPath(); tri.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
    ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.strokeStyle = '#0d47a1'; ctx.lineWidth = 2.5; ctx.stroke();
  }
  return visible;
}
