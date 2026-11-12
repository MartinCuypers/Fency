/**
 * Session de travail : relie l'interface (carte) à un PlanStore, quel qu'il soit.
 * - regroupe les écritures (un seul envoi par élément après une rafale de modifications) ;
 * - applique à l'interface les changements venus des autres appareils ;
 * - ne connaît ni Leaflet, ni Firebase : testable seule.
 *
 * @param {Object} o
 * @param {import('./backends/types.js').PlanStore} o.store
 * @param {Object} o.ui  { applyPlan(meta, features), applyMeta(meta), upsertFeature(f), removeFeature(id), planGone(), status(state, detail) }
 * @param {{get: () => string|null, set: (id: string|null) => void}} [o.remember]  dernier plan ouvert
 */
export function createSession({ store, ui, remember = { get: () => null, set: () => {} }, featureDelay = 250, metaDelay = 400 }) {
  let current = null;         // PlanMeta du plan ouvert
  let unsubscribe = null;
  const pendingFeatures = new Map(); // id -> { feature, timer }
  let pendingMeta = null, metaTimer = null, lastMetaJson = '';
  let inFlight = 0, failed = false;

  const report = () => ui.status?.(failed ? 'error' : (inFlight || pendingFeatures.size || pendingMeta) ? 'saving' : 'saved');
  const run = async (fn) => {
    inFlight++; report();
    try { await fn(); failed = false; } catch (e) { failed = true; console.warn('[fency] enregistrement impossible :', e); ui.status?.('error', e); }
    finally { inFlight--; report(); }
  };
  const metaJson = (m) => JSON.stringify({ name: m.name, params: m.params, genActive: m.genActive });

  function sendFeature(id) {
    const p = pendingFeatures.get(id);
    if (!p || !current) return Promise.resolve();
    clearTimeout(p.timer); pendingFeatures.delete(id);
    const planId = current.id;
    return run(() => store.putFeature(planId, p.feature));
  }
  function sendMeta() {
    clearTimeout(metaTimer); metaTimer = null;
    if (!pendingMeta || !current) return Promise.resolve();
    const patch = pendingMeta, planId = current.id; pendingMeta = null;
    return run(() => store.saveMeta(planId, patch));
  }

  const api = {
    get current() { return current; },

    /** Enregistre (bientôt) un élément ajouté ou modifié. */
    putFeature(feature) {
      if (!current) return;
      const id = feature.properties.id;
      clearTimeout(pendingFeatures.get(id)?.timer);
      pendingFeatures.set(id, { feature, timer: setTimeout(() => sendFeature(id), featureDelay) });
      report();
    },

    removeFeature(id) {
      if (!current) return;
      clearTimeout(pendingFeatures.get(id)?.timer); pendingFeatures.delete(id);
      const planId = current.id;
      run(() => store.deleteFeature(planId, id));
    },

    /** Enregistre (bientôt) nom / paramètres ; ignoré si rien n'a changé. */
    saveMeta(patch) {
      if (!current) return;
      const next = { ...current, ...patch };
      if (metaJson(next) === lastMetaJson) return;
      current = next; lastMetaJson = metaJson(next);
      pendingMeta = { ...(pendingMeta ?? {}), ...patch };
      clearTimeout(metaTimer); metaTimer = setTimeout(sendMeta, metaDelay);
      report();
    },

    /** Envoie tout de suite ce qui attend (avant de changer de plan ou de quitter). */
    async flush() {
      await Promise.all([...pendingFeatures.keys()].map(sendFeature));
      await sendMeta();
    },

    list: () => store.listPlans(),

    /** Ouvre un plan. `join` : s'y ajouter comme membre (lien de partage). */
    async open(id, { join = false } = {}) {
      await api.flush();
      const joined = join ? await store.joinPlan(id) : true;
      const data = joined ? await store.loadPlan(id) : null;
      if (!data) return false;
      unsubscribe?.();
      current = data.meta; lastMetaJson = metaJson(current); failed = false;
      ui.applyPlan(data.meta, data.features);
      unsubscribe = store.subscribePlan(id, {
        onMeta: (m) => { current = m; lastMetaJson = metaJson(m); ui.applyMeta(m); },
        onFeature: (f) => { if (!pendingFeatures.has(f.properties.id)) ui.upsertFeature(f); },
        onFeatureRemoved: (fid) => ui.removeFeature(fid),
        onPlanRemoved: () => { api.close(); ui.planGone?.(); },
      });
      remember.set(id);
      report();
      return true;
    },

    /** Crée un plan (éventuellement prérempli) et l'ouvre. */
    async create(name, { features = [], params = {}, genActive = false } = {}) {
      await api.flush();
      const meta = await store.createPlan({ name, params, genActive });
      for (const f of features) await store.putFeature(meta.id, f);
      await api.open(meta.id);
      return meta;
    },

    async remove(id) {
      if (current?.id === id) api.close();
      await store.deletePlan(id);
      if (remember.get() === id) remember.set(null);
    },

    close() {
      unsubscribe?.(); unsubscribe = null;
      for (const p of pendingFeatures.values()) clearTimeout(p.timer);
      pendingFeatures.clear(); clearTimeout(metaTimer); pendingMeta = null; current = null;
    },
  };
  return api;
}
