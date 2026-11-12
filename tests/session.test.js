import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import { createLocalStore } from '../src/backends/local/store.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (id, x = 0) => ({ type: 'Feature', properties: { id, kind: 'line' }, geometry: { type: 'LineString', coordinates: [[x, 0], [x + 1, 0]] } });
let n = 0;

async function setup() {
  const memory = { plans: new Map(), features: new Map() }, channelName = `s-${n++}`;
  const auth = { user: { id: 'u' } };
  const mk = async () => {
    const store = await createLocalStore({ auth, memory, channelName });
    const calls = { put: 0, meta: 0 };
    const put = store.putFeature, save = store.saveMeta;
    store.putFeature = (...a) => { calls.put++; return put(...a); };
    store.saveMeta = (...a) => { calls.meta++; return save(...a); };
    const ui = { log: [], state: [] };
    const session = createSession({
      store, featureDelay: 20, metaDelay: 20,
      ui: {
        applyPlan: (m, f) => ui.log.push(`plan:${m.name}:${f.length}`), applyMeta: (m) => ui.log.push(`meta:${m.name}`),
        upsertFeature: (f) => ui.log.push(`put:${f.properties.id}`), removeFeature: (id) => ui.log.push(`del:${id}`),
        planGone: () => ui.log.push('gone'), status: (s) => ui.state.push(s),
      },
    });
    return { store, session, ui, calls };
  };
  return { a: await mk(), b: await mk() };
}

test('session : rafale de modifications regroupée en une écriture', async () => {
  const { a } = await setup();
  await a.session.create('Test');
  for (let i = 0; i < 10; i++) a.session.putFeature(line('l1', i)); // glisser un sommet
  for (let i = 0; i < 5; i++) a.session.saveMeta({ params: { angle: i } });
  await wait(60);
  assert.equal(a.calls.put, 1);
  assert.equal(a.calls.meta, 1);
  const { meta, features } = await a.store.loadPlan(a.session.current.id);
  assert.deepEqual(features[0].geometry.coordinates[0], [9, 0]);
  assert.equal(meta.params.angle, 4);
  a.session.saveMeta({ params: { angle: 4 } }); // identique : aucune écriture
  await wait(40);
  assert.equal(a.calls.meta, 1);
  assert.equal(a.ui.state.at(-1), 'saved');
  a.store.close();
});

test('session : flush avant de changer de plan, rien ne fuit dans le plan suivant', async () => {
  const { a } = await setup();
  const p1 = await a.session.create('Un');
  a.session.putFeature(line('l1'));
  const p2 = await a.session.create('Deux', { features: [line('x1'), line('x2')] });
  assert.deepEqual((await a.store.loadPlan(p1.id)).features.map((f) => f.properties.id), ['l1']);
  assert.equal((await a.store.loadPlan(p2.id)).features.length, 2);
  assert.equal(a.ui.log.at(-1), 'plan:Deux:2');
  assert.equal(await a.session.open('inexistant'), false);
  assert.equal(a.session.current.id, p2.id, 'le plan courant reste ouvert');
  a.store.close();
});

test('session : deux appareils sur le même plan', async () => {
  const { a, b } = await setup();
  const p = await a.session.create('Commun');
  assert.equal(await b.session.open(p.id, { join: true }), true);
  a.session.putFeature(line('l1'));
  await wait(80);
  assert.ok(b.ui.log.includes('put:l1'));
  assert.ok(!a.ui.log.includes('put:l1'), 'pas d\'écho chez l\'auteur');
  b.session.saveMeta({ name: 'Renommé par B' });
  b.session.removeFeature('l1');
  await wait(80);
  assert.ok(a.ui.log.includes('meta:Renommé par B'));
  assert.ok(a.ui.log.includes('del:l1'));
  assert.equal(a.session.current.name, 'Renommé par B');
  await b.session.remove(p.id);
  await wait(40);
  assert.ok(a.ui.log.includes('gone'));
  assert.equal(a.session.current, null);
  a.store.close(); b.store.close();
});

test('session : erreur de stockage signalée, puis rétablie', async () => {
  const { a } = await setup();
  await a.session.create('Err');
  const real = a.store.putFeature; let fail = true;
  a.store.putFeature = (...x) => (fail ? Promise.reject(new Error('hors ligne')) : real(...x));
  const warn = console.warn; console.warn = () => {};
  a.session.putFeature(line('l1')); await wait(50);
  console.warn = warn;
  assert.equal(a.ui.state.at(-1), 'error');
  fail = false;
  a.session.putFeature(line('l1')); await wait(50);
  assert.equal(a.ui.state.at(-1), 'saved');
  a.store.close();
});
