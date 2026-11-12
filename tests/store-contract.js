// Suite de contrat : tout PlanStore (local, Firestore, futur hébergement) doit la passer.
// `makePair()` renvoie deux magasins A et B branchés sur les MÊMES données, comme
// deux appareils (ou deux onglets), plus leurs utilisateurs.
import test from 'node:test';
import assert from 'node:assert/strict';

const line = (id, coords = [[-1.5, 47.2], [-1.49, 47.2]]) => ({
  type: 'Feature', properties: { id, kind: 'line' }, geometry: { type: 'LineString', coordinates: coords },
});
const field = (id) => ({
  type: 'Feature', properties: { id, kind: 'field' },
  geometry: { type: 'Polygon', coordinates: [[[-1.5, 47.2], [-1.49, 47.2], [-1.49, 47.21], [-1.5, 47.2]]] },
});
const until = async (cond, ms = 1000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('délai dépassé'); await new Promise((r) => setTimeout(r, 5)); }
};

export function runStoreContract(name, makePair) {
  test(`${name} : créer, lister, charger, modifier, supprimer un plan`, async () => {
    const { a, cleanup } = await makePair();
    const p1 = await a.createPlan({ name: 'Champ du haut', params: { spacing: 10 }, genActive: true });
    await new Promise((r) => setTimeout(r, 3));
    const p2 = await a.createPlan({ name: 'Champ du bas' });
    assert.notEqual(p1.id, p2.id);
    assert.deepEqual((await a.listPlans()).map((p) => p.name), ['Champ du bas', 'Champ du haut']);

    await a.saveMeta(p1.id, { name: 'Renommé', params: { spacing: 12 } });
    const loaded = await a.loadPlan(p1.id);
    assert.equal(loaded.meta.name, 'Renommé');
    assert.equal(loaded.meta.params.spacing, 12);
    assert.equal(loaded.meta.genActive, true);
    assert.deepEqual(loaded.features, []);

    await a.deletePlan(p2.id);
    assert.equal(await a.loadPlan(p2.id), null);
    assert.deepEqual((await a.listPlans()).map((p) => p.id), [p1.id]);
    await cleanup();
  });

  test(`${name} : éléments (géométrie imbriquée conservée, mise à jour, suppression)`, async () => {
    const { a, cleanup } = await makePair();
    const p = await a.createPlan({ name: 'P' });
    await a.putFeature(p.id, field('f1'));
    await a.putFeature(p.id, line('l1'));
    await a.putFeature(p.id, line('l1', [[-1.6, 47.3], [-1.59, 47.3], [-1.58, 47.31]])); // même id : remplacement
    let { features } = await a.loadPlan(p.id);
    assert.equal(features.length, 2);
    const l1 = features.find((f) => f.properties.id === 'l1'), f1 = features.find((f) => f.properties.id === 'f1');
    assert.deepEqual(l1.geometry.coordinates, [[-1.6, 47.3], [-1.59, 47.3], [-1.58, 47.31]]);
    assert.equal(f1.geometry.type, 'Polygon');
    assert.equal(f1.geometry.coordinates[0].length, 4);
    assert.equal(l1.properties.kind, 'line');
    assert.ok(l1.properties.updatedAt > 0);

    await a.deleteFeature(p.id, 'f1');
    ({ features } = await a.loadPlan(p.id));
    assert.deepEqual(features.map((f) => f.properties.id), ['l1']);

    // supprimer le plan supprime aussi ses éléments
    await a.deletePlan(p.id);
    const q = await a.createPlan({ name: 'Q' });
    assert.deepEqual((await a.loadPlan(q.id)).features, []);
    await cleanup();
  });

  test(`${name} : un autre client reçoit les changements, jamais l'écho des siens`, async () => {
    const { a, b, cleanup } = await makePair();
    const p = await a.createPlan({ name: 'Partagé' });
    assert.ok(await b.joinPlan(p.id), 'B rejoint le plan');
    const seenA = [], seenB = [];
    const rec = (log) => ({
      onMeta: (m) => log.push(`meta:${m.name}`), onFeature: (f) => log.push(`put:${f.properties.id}`),
      onFeatureRemoved: (id) => log.push(`del:${id}`), onPlanRemoved: () => log.push('gone'),
    });
    const offA = a.subscribePlan(p.id, rec(seenA)), offB = b.subscribePlan(p.id, rec(seenB));

    await a.putFeature(p.id, line('l1'));
    await until(() => seenB.includes('put:l1'));
    await b.putFeature(p.id, line('l2'));
    await until(() => seenA.includes('put:l2'));
    await a.saveMeta(p.id, { name: 'Nouveau nom' });
    await until(() => seenB.includes('meta:Nouveau nom'));
    await b.deleteFeature(p.id, 'l1');
    await until(() => seenA.includes('del:l1'));

    assert.ok(!seenA.includes('put:l1'), 'A ne reçoit pas sa propre écriture');
    assert.ok(!seenB.includes('put:l2'), 'B ne reçoit pas sa propre écriture');
    assert.ok(!seenA.includes('meta:Nouveau nom'));
    // les deux voient le même état final
    assert.deepEqual((await a.loadPlan(p.id)).features.map((f) => f.properties.id), ['l2']);
    assert.deepEqual((await b.loadPlan(p.id)).features.map((f) => f.properties.id), ['l2']);

    // après désabonnement, plus de notification
    offB();
    await a.putFeature(p.id, line('l3'));
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!seenB.includes('put:l3'));

    await b.deletePlan(p.id).catch(() => a.deletePlan(p.id));
    await until(() => seenA.includes('gone'));
    offA();
    await cleanup();
  });

  test(`${name} : rejoindre un plan inexistant renvoie null`, async () => {
    const { a, cleanup } = await makePair();
    assert.equal(await a.joinPlan('inexistant'), null);
    assert.equal(await a.loadPlan('inexistant'), null);
    await cleanup();
  });
}
