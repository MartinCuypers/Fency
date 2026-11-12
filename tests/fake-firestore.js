// Faux SDK Firestore en mémoire, juste assez fidèle pour tester l'adaptateur :
// documents, sous-collections, requête array-contains, onSnapshot, arrayUnion, batch.
export function createFakeFirestore() {
  const docs = new Map();      // chemin -> données
  const listeners = new Set(); // { kind: 'doc'|'col', path, cb, filter }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const parentOf = (path) => path.split('/').slice(0, -1).join('/');
  const idOf = (path) => path.split('/').pop();
  const docSnap = (path) => ({ id: idOf(path), exists: () => docs.has(path), data: () => clone(docs.get(path)) });

  function notify(path, type) {
    for (const l of [...listeners]) {
      if (l.kind === 'doc' && l.path === path) l.cb(docSnap(path));
      if (l.kind === 'col' && l.path === parentOf(path)) {
        const data = type === 'removed' ? l.last.get(path) : docs.get(path);
        const doc = { id: idOf(path), data: () => clone(data) };
        if (type === 'removed') l.last.delete(path); else l.last.set(path, clone(data));
        l.cb({ docChanges: () => [{ type, doc }] });
      }
    }
  }
  const write = (path, data) => { const type = docs.has(path) ? 'modified' : 'added'; docs.set(path, clone(data)); notify(path, type); };
  const remove = (path) => { if (docs.delete(path)) notify(path, 'removed'); };
  const inCol = (colPath) => [...docs.keys()].filter((p) => parentOf(p) === colPath);

  const fs = {
    doc: (_db, ...seg) => ({ kind: 'doc', path: seg.join('/') }),
    collection: (_db, ...seg) => ({ kind: 'col', path: seg.join('/') }),
    where: (field, op, value) => ({ field, op, value }),
    query: (col, w) => ({ ...col, filter: w }),
    arrayUnion: (v) => ({ __union: v }),
    async getDoc(ref) { return docSnap(ref.path); },
    async getDocs(q) {
      let paths = inCol(q.path);
      if (q.filter) {
        if (q.filter.op !== 'array-contains') throw new Error('opérateur non géré');
        paths = paths.filter((p) => (docs.get(p)[q.filter.field] ?? []).includes(q.filter.value));
      }
      return { docs: paths.map(docSnap) };
    },
    async setDoc(ref, data) { write(ref.path, data); },
    async updateDoc(ref, patch) {
      if (!docs.has(ref.path)) throw new Error('document inexistant');
      const cur = clone(docs.get(ref.path));
      for (const [k, v] of Object.entries(patch)) {
        if (v && v.__union !== undefined) cur[k] = [...new Set([...(cur[k] ?? []), v.__union])];
        else cur[k] = v;
      }
      write(ref.path, cur);
    },
    async deleteDoc(ref) { remove(ref.path); },
    writeBatch: () => {
      const ops = [];
      return { delete: (ref) => ops.push(ref.path), commit: async () => ops.forEach(remove) };
    },
    onSnapshot(ref, cb) {
      const l = { kind: ref.kind, path: ref.path, cb, last: new Map() };
      listeners.add(l);
      if (ref.kind === 'doc') cb(docSnap(ref.path));
      else {
        const changes = inCol(ref.path).map((p) => { l.last.set(p, clone(docs.get(p))); return { type: 'added', doc: { id: idOf(p), data: () => clone(docs.get(p)) } }; });
        cb({ docChanges: () => changes });
      }
      return () => listeners.delete(l);
    },
  };
  return { fs, db: {}, docs };
}
