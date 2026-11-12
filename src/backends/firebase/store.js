import { uid, stamp } from '../types.js';

/**
 * PlanStore sur Cloud Firestore : synchronisation en temps réel et partage.
 *
 *   plans/{planId}                 { name, params, genActive, ownerId, memberIds[], updatedAt, by }
 *   plans/{planId}/features/{fid}  { kind, geometry (JSON en texte), updatedAt, by }
 *
 * La géométrie est stockée en texte car Firestore refuse les tableaux imbriqués
 * (coordonnées GeoJSON). Les fonctions du SDK sont injectées (`fs`) pour pouvoir
 * tester l'adaptateur sans réseau.
 *
 * @param {Object} o
 * @param {*} o.db                     instance Firestore
 * @param {Object} o.fs                fonctions du SDK firebase/firestore
 * @param {import('../types.js').AuthProvider} o.auth
 * @returns {import('../types.js').PlanStore}
 */
export function createFirestoreStore({ db, fs, auth, clientId = uid() }) {
  const planRef = (id) => fs.doc(db, 'plans', id);
  const featuresCol = (id) => fs.collection(db, 'plans', id, 'features');
  const featureRef = (id, fid) => fs.doc(db, 'plans', id, 'features', fid);
  const me = () => {
    const u = auth.user;
    if (!u) throw new Error('Connexion requise');
    return u.id;
  };

  const toMeta = (id, d) => ({
    id, name: d.name ?? 'Sans nom', params: d.params ?? {}, genActive: !!d.genActive,
    ownerId: d.ownerId, memberIds: d.memberIds ?? [], updatedAt: d.updatedAt ?? 0, by: d.by ?? '',
  });
  const toFeature = (fid, d) => ({
    type: 'Feature',
    properties: { id: fid, kind: d.kind, updatedAt: d.updatedAt ?? 0, by: d.by ?? '' },
    geometry: JSON.parse(d.geometry),
  });

  return {
    capabilities: { realtime: true, sharing: true },

    async listPlans() {
      const snap = await fs.getDocs(fs.query(fs.collection(db, 'plans'), fs.where('memberIds', 'array-contains', me())));
      return snap.docs.map((d) => toMeta(d.id, d.data())).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async createPlan({ name, params = {}, genActive = false }) {
      const owner = me(), id = uid();
      const data = { name, params, genActive, ownerId: owner, memberIds: [owner], updatedAt: Date.now(), by: clientId };
      await fs.setDoc(planRef(id), data);
      return toMeta(id, data);
    },

    async loadPlan(id) {
      const snap = await fs.getDoc(planRef(id));
      if (!snap.exists()) return null;
      const feats = await fs.getDocs(featuresCol(id));
      return { meta: toMeta(id, snap.data()), features: feats.docs.map((d) => toFeature(d.id, d.data())) };
    },

    async saveMeta(id, patch) {
      const { id: _i, ownerId: _o, memberIds: _m, ...rest } = patch; // appartenance : jamais modifiée ici
      await fs.updateDoc(planRef(id), { ...rest, updatedAt: Date.now(), by: clientId });
    },

    async deletePlan(id) {
      const feats = await fs.getDocs(featuresCol(id));
      const batch = fs.writeBatch(db);
      feats.docs.forEach((d) => batch.delete(featureRef(id, d.id)));
      batch.delete(planRef(id));
      await batch.commit();
    },

    async putFeature(planId, feature) {
      const f = stamp(feature, clientId);
      await fs.setDoc(featureRef(planId, f.properties.id), {
        kind: f.properties.kind, geometry: JSON.stringify(f.geometry), updatedAt: f.properties.updatedAt, by: clientId,
      });
    },

    async deleteFeature(planId, featureId) {
      await fs.deleteDoc(featureRef(planId, featureId));
    },

    subscribePlan(planId, h) {
      const offMeta = fs.onSnapshot(planRef(planId), (snap) => {
        if (!snap.exists()) return h.onPlanRemoved?.();
        const d = snap.data();
        if (d.by !== clientId) h.onMeta?.(toMeta(planId, d));
      }, () => {});
      const offFeatures = fs.onSnapshot(featuresCol(planId), (snap) => {
        for (const ch of snap.docChanges()) {
          if (ch.type === 'removed') h.onFeatureRemoved?.(ch.doc.id);
          else if (ch.doc.data().by !== clientId) h.onFeature?.(toFeature(ch.doc.id, ch.doc.data()));
        }
      }, () => {});
      return () => { offMeta(); offFeatures(); };
    },

    /** Partage par lien : connaître l'identifiant du plan permet de s'y ajouter. */
    async joinPlan(id) {
      const user = me();
      const snap = await fs.getDoc(planRef(id));
      if (!snap.exists()) return null;
      const d = snap.data();
      if (!(d.memberIds ?? []).includes(user)) {
        await fs.updateDoc(planRef(id), { memberIds: fs.arrayUnion(user) });
        d.memberIds = [...(d.memberIds ?? []), user];
      }
      return toMeta(id, d);
    },

    close() {},
  };
}
