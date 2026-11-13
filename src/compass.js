// Cap du téléphone (boussole) à partir des capteurs d'orientation du navigateur.
const RAD = Math.PI / 180;

/**
 * Cap (0 = nord, sens horaire) de la direction vers laquelle « regarde » le haut de l'écran.
 *
 * Le téléphone sur un quad est rarement à plat : il est incliné sur son support, parfois
 * presque vertical, en portrait ou en paysage. On projette donc au sol deux axes de
 * l'appareil, le haut de l'écran et le dos du téléphone, et on les additionne : à plat
 * seul le premier compte, à la verticale seul le second, avec une transition continue.
 *
 * @param {{alpha: number, beta: number, gamma: number}} o  angles de DeviceOrientationEvent (absolu)
 * @param {number} screenAngle  screen.orientation.angle (0, 90, 180, 270)
 * @returns {number|null} cap en degrés, ou null si indéterminé
 */
export function headingFromOrientation({ alpha, beta, gamma }, screenAngle = 0) {
  if (alpha == null || beta == null || gamma == null) return null;
  const ca = Math.cos(alpha * RAD), sa = Math.sin(alpha * RAD);
  const cb = Math.cos(beta * RAD), sb = Math.sin(beta * RAD);
  const cg = Math.cos(gamma * RAD), sg = Math.sin(gamma * RAD);
  // Repère terrestre : x = est, y = nord, z = haut. R = Rz(alpha) · Rx(beta) · Ry(gamma).
  // Composantes est/nord des axes de l'appareil :
  const X = [ca * cg - sa * sb * sg, sa * cg + ca * sb * sg]; // bord droit
  const Y = [-sa * cb, ca * cb];                              // haut (en portrait)
  const back = [-(ca * sg + sa * sb * cg), -(sa * sg - ca * sb * cg)]; // dos du téléphone
  // haut de l'écran selon la rotation de l'affichage
  const t = screenAngle * RAD, st = Math.sin(t), ct = Math.cos(t);
  const up = [X[0] * st + Y[0] * ct, X[1] * st + Y[1] * ct];
  const e = up[0] + back[0], n = up[1] + back[1];
  if (Math.hypot(e, n) < 0.05) return null; // écran face au ciel et dos au sol qui s'annulent : indéterminé
  return (Math.atan2(e, n) / RAD + 360) % 360;
}

/** Écart angulaire signé a - b, dans ]-180, 180]. */
export const angleDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;

/** Lissage d'un angle (moyenne glissante sur le cercle). k = 1 : pas de lissage. */
export function smoothAngle(prev, next, k = 0.25) {
  if (prev == null) return next;
  return (prev + angleDiff(next, prev) * k + 360) % 360;
}

/**
 * Écoute la boussole. `onHeading(cap)` est appelé à chaque mesure.
 * @returns {Promise<{supported: boolean, stop: () => void}>}
 */
export async function startCompass(onHeading, win = globalThis) {
  const DOE = win.DeviceOrientationEvent;
  if (!DOE) return { supported: false, stop() {} };
  // iOS : autorisation à demander sur une action de l'utilisateur
  if (typeof DOE.requestPermission === 'function') {
    try { if ((await DOE.requestPermission()) !== 'granted') return { supported: false, stop() {} }; }
    catch { return { supported: false, stop() {} }; }
  }
  let heading = null, gotAbsolute = false;
  const handler = (ev) => {
    const angle = win.screen?.orientation?.angle ?? win.orientation ?? 0;
    let h = null;
    if (typeof ev.webkitCompassHeading === 'number') h = (ev.webkitCompassHeading + angle + 360) % 360; // iOS
    else if (ev.absolute || ev.type === 'deviceorientationabsolute') { gotAbsolute = true; h = headingFromOrientation(ev, angle); }
    else if (gotAbsolute) return; // orientation relative : inutilisable comme boussole
    if (h == null) return;
    heading = smoothAngle(heading, h);
    onHeading(heading);
  };
  win.addEventListener('deviceorientationabsolute', handler);
  win.addEventListener('deviceorientation', handler);
  return {
    supported: true,
    stop() { win.removeEventListener('deviceorientationabsolute', handler); win.removeEventListener('deviceorientation', handler); },
  };
}
