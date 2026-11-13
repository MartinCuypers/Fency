import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProjection, areaLL, lengthLL, longestEdgeBearing } from '../src/geo.js';
import { generateStrips } from '../src/generate.js';
import { prepareLine, locate, pointAt, estimateMaterial, toStart, bearingAt, nextPhase, nearerEndIsLast } from '../src/guidance.js';
import { headingFromOrientation, angleDiff, smoothAngle } from '../src/compass.js';
import { makeCamera, toCameraFrame } from '../src/perspective.js';

// Rectangle 200 m (est-ouest) x 100 m (nord-sud) = 2 ha, près de Rennes
const origin = [-1.68, 48.11];
const p = makeProjection(origin);
const rect = [[0, 0], [200, 0], [200, 100], [0, 100], [0, 0]].map(p.toLL);

test('surface et longueur', () => {
  assert.ok(Math.abs(areaLL(rect) - 20000) < 20);
  assert.ok(Math.abs(lengthLL([rect[0], rect[1]]) - 200) < 0.5);
});

test('plus long côté = est-ouest (cap 90)', () => {
  assert.equal(longestEdgeBearing(rect), 90);
});

test('bandes de 20 m sur 100 m : 4 clôtures, 5 bandes', () => {
  const g = generateStrips(rect, { bearing: 90, mode: 'width', value: 20 });
  assert.equal(g.lines.length, 4);
  assert.equal(g.strips.length, 5);
  for (const l of g.lines) assert.ok(Math.abs(l.length - 200) < 0.5);
  for (const s of g.strips) assert.ok(Math.abs(s.area - 4000) < 40);
});

test('mode surface : 0,5 ha par bande -> 4 bandes', () => {
  const g = generateStrips(rect, { bearing: 90, mode: 'area', value: 5000 });
  assert.equal(g.strips.length, 4);
  for (const s of g.strips) assert.ok(Math.abs(s.area - 5000) < 60);
});

test('champ non rectangulaire (triangle) : surfaces égales', () => {
  const tri = [[0, 0], [200, 0], [0, 100], [0, 0]].map(p.toLL);
  const g = generateStrips(tri, { bearing: 90, mode: 'area', value: 2500 });
  assert.equal(g.strips.length, 4);
  for (const s of g.strips) assert.ok(Math.abs(s.area - 2500) < 40, `aire ${s.area}`);
});

test('sens inverse : la première bande part de l\'autre côté', () => {
  const a = generateStrips(rect, { bearing: 90, value: 30 });
  const b = generateStrips(rect, { bearing: 90, value: 30, reverse: true });
  const latA = a.lines[0].coords[0][1], latB = b.lines[0].coords[0][1];
  assert.ok(latA < latB); // a part du sud, b du nord
});

test('guidage : écart latéral signé', () => {
  // ligne d\'ouest en est ; un point au sud est à DROITE du sens de marche
  const line = prepareLine([p.toLL([0, 0]), p.toLL([100, 0])]);
  const south = locate(line, p.toLL([40, -3]));
  assert.ok(Math.abs(south.cross - 3) < 0.05 && Math.abs(south.along - 40) < 0.05);
  const north = locate(line, p.toLL([40, 2]));
  assert.ok(Math.abs(north.cross + 2) < 0.05);
});

test('pointAt et matériel', () => {
  const line = prepareLine([p.toLL([0, 0]), p.toLL([100, 0]), p.toLL([100, 50])]);
  assert.ok(Math.abs(line.length - 150) < 0.1);
  const q = p.toXY(pointAt(line, 125));
  assert.ok(Math.abs(q[0] - 100) < 0.1 && Math.abs(q[1] - 25) < 0.1);
  const m = estimateMaterial([200, 200], { rows: 2 });
  assert.deepEqual(m, { total: 400, wire: 800 });
});

test('guidage : rejoindre le départ (distance et cap), cap de la ligne', () => {
  const line = prepareLine([p.toLL([0, 0]), p.toLL([100, 0]), p.toLL([100, 50])]); // vers l'est, puis vers le nord
  const s = toStart(line, p.toLL([30, -40])); // départ à 50 m, au nord-ouest
  assert.ok(Math.abs(s.dist - 50) < 0.05, `distance ${s.dist}`);
  assert.ok(Math.abs(s.bearing - (360 - 36.87)) < 0.1, `cap ${s.bearing}`);
  assert.ok(Math.abs(toStart(line, p.toLL([0, -10])).bearing) < 0.01, 'départ plein nord');
  assert.ok(Math.abs(bearingAt(line, 40) - 90) < 0.01);
  assert.ok(Math.abs(bearingAt(line, 120)) < 0.01);
  assert.equal(nearerEndIsLast([p.toLL([0, 0]), p.toLL([100, 0])], p.toLL([90, 5])), true);
  assert.equal(nearerEndIsLast([p.toLL([0, 0]), p.toLL([100, 0])], p.toLL([20, 5])), false);
});

test('guidage : enchaînement des deux étapes', () => {
  const L = 100, at = (o) => ({ distStart: 50, cross: 0, along: 0, length: L, accuracy: 0.5, ...o });
  // au lancement
  assert.equal(nextPhase(null, at({ distStart: 60, cross: 40, along: 20 })), 'approach', 'loin de la clôture');
  assert.equal(nextPhase(null, at({ distStart: 2 })), 'lay', 'déjà au départ');
  assert.equal(nextPhase(null, at({ distStart: 45, cross: 1.5, along: 45 })), 'lay', 'déjà engagé le long de la clôture');
  // étape 1 -> 2 en arrivant au départ, pas en longeant la clôture
  assert.equal(nextPhase('approach', at({ distStart: 30, cross: 0.5, along: 30 })), 'approach');
  assert.equal(nextPhase('approach', at({ distStart: 2.9 })), 'lay');
  assert.equal(nextPhase('approach', at({ distStart: 6, accuracy: 5 })), 'lay', 'rayon élargi si GPS imprécis');
  assert.equal(nextPhase('approach', at({ distStart: 6, accuracy: 1 })), 'approach');
  // étape 2 : s'écarter ne renvoie pas à l'étape 1 ; fin au bout de la ligne
  assert.equal(nextPhase('lay', at({ distStart: 50, cross: 12, along: 50 })), 'lay');
  assert.equal(nextPhase('lay', at({ along: 99.8, cross: 0.4 })), 'done');
  assert.equal(nextPhase('lay', at({ along: 100, cross: 30 })), 'lay', 'au bout mais loin de la ligne');
  assert.equal(nextPhase('done', at({ along: 50 })), 'done');
});

test('boussole : cap selon l\'inclinaison et la rotation de l\'écran', () => {
  const near = (h, expect, msg) => assert.ok(Math.abs(angleDiff(h, expect)) < 0.5, `${msg} : ${h?.toFixed(1)} au lieu de ${expect}`);
  const H = (alpha, beta, gamma, screen = 0) => headingFromOrientation({ alpha, beta, gamma }, screen);
  // à plat : alpha se compte dans le sens anti-horaire
  near(H(0, 0, 0), 0, 'à plat, haut vers le nord');
  near(H(90, 0, 0), 270, 'à plat, haut vers l\'ouest');
  near(H(270, 0, 0), 90, 'à plat, haut vers l\'est');
  // incliné sur un support (45°), puis vertical : le cap ne change pas
  for (const beta of [20, 45, 70, 90]) {
    near(H(0, beta, 0), 0, `incliné ${beta}°, face au nord`);
    near(H(250, beta, 0), 110, `incliné ${beta}°, cap 110`);
  }
  // paysage : le haut de l'écran est le bord droit (angle 90) ou gauche (270) de l'appareil
  near(H(0, 0, 0, 90), 90, 'paysage à plat');
  near(H(0, 0, 0, 270), 270, 'paysage inversé à plat');
  near(H(90, 0, -60, 90), 0, 'paysage sur support, face au nord'); // haut de l'appareil vers l'ouest, relevé de 60° autour de cet axe
  assert.equal(headingFromOrientation({ alpha: null, beta: 0, gamma: 0 }), null);
  // lissage : passage par le nord sans faire le grand tour
  near(smoothAngle(350, 10, 0.5), 0, 'lissage autour du nord');
  near(smoothAngle(null, 123), 123, 'première mesure');
  assert.equal(angleDiff(10, 350), 20); assert.equal(angleDiff(350, 10), -20);
});

test('perspective : projection du sol', () => {
  const cam = makeCamera({ width: 400, height: 240 });
  const p = (x, y, z = 0) => cam.project([x, y, z]);
  assert.ok(Math.abs(p(0, 5)[0] - 200) < 1e-9, 'l\'axe reste au centre');
  assert.ok(p(0, 2)[1] > p(0, 10)[1] && p(0, 10)[1] > p(0, 100)[1], 'plus loin = plus haut');
  assert.ok(p(0, 1e6)[1] - cam.horizonY < 0.01 && p(0, 1e6)[1] >= cam.horizonY - 0.01, 'converge vers l\'horizon');
  assert.ok(Math.abs((p(2, 5)[0] - 200) + (p(-2, 5)[0] - 200)) < 1e-9, 'symétrie gauche/droite');
  assert.ok(p(1, 3)[0] - 200 > p(1, 20)[0] - 200, 'un mètre paraît plus petit au loin');
  assert.ok(p(0, 5, 1.6)[1] < p(0, 5, 0)[1], 'un jalon monte à l\'écran');
  assert.ok(p(0, 0)[1] > 150 && p(0, 0)[1] < 240, 'le quad est visible en bas de l\'écran');
  assert.equal(p(0, -10), null, 'derrière la caméra');
  // découpe d'un segment qui passe derrière la caméra
  const s = cam.clip([1, -20, 0], [1, 10, 0]);
  assert.ok(s && s.every((q) => q.every(Number.isFinite)));
  assert.equal(cam.clip([0, -20, 0], [5, -10, 0]), null);
  // repère caméra : face à l'est, un point à l'est est devant, un point au nord est à gauche
  const near = (a, b) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9, `${a} / ${b}`);
  near(toCameraFrame([10, 0], 90), [0, 10]);
  near(toCameraFrame([0, 10], 90), [-10, 0]);
  near(toCameraFrame([3, 4], 0), [3, 4]);
});
