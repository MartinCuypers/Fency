import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProjection, areaLL, lengthLL, longestEdgeBearing } from '../src/geo.js';
import { generateStrips } from '../src/generate.js';
import { prepareLine, locate, pointAt, postPositions, estimateMaterial } from '../src/guidance.js';

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

test('pointAt et piquets', () => {
  const line = prepareLine([p.toLL([0, 0]), p.toLL([100, 0]), p.toLL([100, 50])]);
  assert.ok(Math.abs(line.length - 150) < 0.1);
  const q = p.toXY(pointAt(line, 125));
  assert.ok(Math.abs(q[0] - 100) < 0.1 && Math.abs(q[1] - 25) < 0.1);
  assert.deepEqual(postPositions(35, 10), [0, 10, 20, 30, 35]);
  const m = estimateMaterial([200, 200], { spacing: 10, rows: 2 });
  assert.equal(m.posts, 42);
  assert.equal(m.wire, 800);
});
