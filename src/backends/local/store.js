import { uid, stamp } from '../types.js';

// ------------------------------------------------------------------ stockage bas niveau
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Stockage IndexedDB : une table de plans, une table d'éléments indexée par plan. */
async function idbKV(idb, dbName) {
  const open = idb.open(dbName, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore('plans', { keyPath: 'id' });
    db.createObjectStore('features', { keyPath: ['planId', 'id'] }).createIndex('planId', 'planId');
  };
  const db = await req(open);
  const tx = (names, mode) => db.transaction(names, mode);
  const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  return {
    allPlans: () => req(tx('plans').objectStore('plans').getAll()),
    getPlan: (id) => req(tx('plans').objectStore('plans').get(id)),
    async putPlan(p) { const t = tx('plans', 'readwrite'); t.objectStore('plans').put(p); await done(t); },
    featuresOf: (planId) => req(tx('features').objectStore('features').index('planId').getAll(planId)),
    async putFeature(rec) { const t = tx('features', 'readwrite'); t.objectStore('features').put(rec); await done(t); },
    async delFeature(planId, id) { const t = tx('features', 'readwrite'); t.objectStore('features').delete([planId, id]); await done(t); },
    async delPlan(id) {
      const t = tx(['plans', 'features'], 'readwrite');
      t.objectStore('plans').delete(id);
      const cur = t.objectStore('features').index('planId').openKeyCursor(IDBKeyRange.only(id));
      cur.onsuccess = () => { const c = cur.result; if (c) { t.objectStore('features').delete(c.primaryKey); c.continue(); } };
      await done(t);
    },
    close: () => db.close(),
  };
}

/** Stockage en mémoire : secours quand IndexedDB est indisponible (navigation privée), et tests. */
function memoryKV(shared = { plans: new Map(), features: new Map() }) {
  const key = (p, f) => `${p}/${f}`;
  return {
    allPlans: async () => [...shared.plans.values()],
    getPlan: async (id) => shared.plans.get(id),
    putPlan: async (p) => { shared.plans.set(p.id, p); },
    featuresOf: async (planId) => [...shared.features.values()].filter((r) => r.planId === planId),
    putFeature: async (rec) => { shared.features.set(key(rec.planId, rec.id), rec); },
    delFeature: async (planId, id) => { shared.features.delete(key(planId, id)); },
    delPlan: async (id) => {
      shared.plans.delete(id);
      for (const [k, r] of shared.features) if (r.planId === id) shared.features.delete(k);
    },
    close: () => {},
  };
}

// ------------------------------------------------------------------ PlanStore local
/**
 * Stockage sur l'appareil (IndexedDB). Les autres onglets du même navigateur sont
 * prévenus en direct par BroadcastChannel ; aucun partage entre appareils.
 *
 * @param {Object} o
 * @param {import('../types.js').AuthProvider} o.auth
 * @param {string} [o.clientId]
 * @param {IDBFactory|null} [o.idb]      null : forcer le stockage en mémoire
 * @param {Object} [o.memory]            état partagé du stockage en mémoire (tests)
 * @returns {Promise<import('../types.js').PlanStore & {persistent: boolean}>}
 */
export async function createLocalStore({ auth, clientId = uid(), idb = globalThis.indexedDB, memory, dbName = 'fency', channelName = 'fency-plans' }) {
  let kv, persistent = false;
  if (idb && !memory) {
    try { kv = await idbKV(idb, dbName); persistent = true; } catch { /* repli mémoire */ }
  }
  kv ??= memoryKV(memory);

  const subs = new Map(); // planId -> Set<handlers>
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : null;
  channel?.unref?.(); // Node : ne pas retenir le processus
  const emit = (msg) => channel?.postMessage({ ...msg, by: clientId });
  if (channel) channel.onmessage = ({ data }) => {
    if (!data || data.by === clientId) return;
    for (const h of subs.get(data.planId) ?? []) {
      if (data.type === 'meta') h.onMeta?.(data.meta);
      else if (data.type === 'feature') h.onFeature?.(data.feature);
      else if (data.type === 'featureRemoved') h.onFeatureRemoved?.(data.id);
      else if (data.type === 'planRemoved') h.onPlanRemoved?.();
    }
  };

  const touch = async (planId) => {
    const p = await kv.getPlan(planId);
    if (p) await kv.putPlan({ ...p, updatedAt: Date.now() });
  };

  return {
    persistent,
    capabilities: { realtime: false, sharing: false },

    async listPlans() {
      return (await kv.allPlans()).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async createPlan({ name, params = {}, genActive = false }) {
      const owner = auth.user?.id ?? 'local';
      const meta = { id: uid(), name, params, genActive, ownerId: owner, memberIds: [owner], updatedAt: Date.now(), by: clientId };
      await kv.putPlan(meta);
      return meta;
    },

    async loadPlan(id) {
      const meta = await kv.getPlan(id);
      if (!meta) return null;
      return { meta, features: (await kv.featuresOf(id)).map((r) => r.feature) };
    },

    async saveMeta(id, patch) {
      const cur = await kv.getPlan(id);
      if (!cur) throw new Error('Plan introuvable');
      const meta = { ...cur, ...patch, id, updatedAt: Date.now(), by: clientId };
      await kv.putPlan(meta);
      emit({ type: 'meta', planId: id, meta });
    },

    async deletePlan(id) {
      await kv.delPlan(id);
      emit({ type: 'planRemoved', planId: id });
    },

    async putFeature(planId, feature) {
      const f = stamp(feature, clientId);
      await kv.putFeature({ planId, id: f.properties.id, feature: f });
      await touch(planId);
      emit({ type: 'feature', planId, feature: f });
    },

    async deleteFeature(planId, featureId) {
      await kv.delFeature(planId, featureId);
      await touch(planId);
      emit({ type: 'featureRemoved', planId, id: featureId });
    },

    subscribePlan(planId, handlers) {
      if (!subs.has(planId)) subs.set(planId, new Set());
      subs.get(planId).add(handlers);
      return () => subs.get(planId)?.delete(handlers);
    },

    async joinPlan(id) { return (await kv.getPlan(id)) ?? null; },

    close() { channel?.close(); kv.close(); },
  };
}
