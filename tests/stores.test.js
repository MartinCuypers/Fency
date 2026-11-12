import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runStoreContract } from './store-contract.js';
import { createLocalStore } from '../src/backends/local/store.js';
import { createLocalAuth } from '../src/backends/local/auth.js';
import { createFirestoreStore } from '../src/backends/firebase/store.js';
import { createFirebaseAuth, authErrorMessage } from '../src/backends/firebase/auth.js';
import { createBackend, readConfig, registerBackend } from '../src/backends/index.js';
import { createFakeFirestore } from './fake-firestore.js';

const fakeStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
let n = 0;

runStoreContract('local (mémoire)', async () => {
  const memory = { plans: new Map(), features: new Map() }, channelName = `t-${n++}`;
  const auth = createLocalAuth(fakeStorage());
  const a = await createLocalStore({ auth, memory, channelName }), b = await createLocalStore({ auth, memory, channelName });
  return { a, b, cleanup: async () => { a.close(); b.close(); } };
});

runStoreContract('local (IndexedDB)', async () => {
  const dbName = `fency-test-${n++}`, channelName = `t-${n++}`;
  const auth = createLocalAuth(fakeStorage());
  const a = await createLocalStore({ auth, dbName, channelName }), b = await createLocalStore({ auth, dbName, channelName });
  assert.ok(a.persistent, 'IndexedDB utilisé');
  return { a, b, cleanup: async () => { a.close(); b.close(); } };
});

runStoreContract('Firestore (faux SDK)', async () => {
  const { fs, db } = createFakeFirestore();
  const user = (id) => ({ user: { id, name: id, email: `${id}@test`, anonymous: false } });
  const a = createFirestoreStore({ db, fs, auth: user('alice') }), b = createFirestoreStore({ db, fs, auth: user('bob') });
  return { a, b, cleanup: async () => {} };
});

test('Firestore : chaque utilisateur ne liste que ses plans ; rejoindre ajoute le membre', async () => {
  const { fs, db, docs } = createFakeFirestore();
  const mk = (id) => createFirestoreStore({ db, fs, auth: { user: { id } } });
  const alice = mk('alice'), bob = mk('bob');
  const p = await alice.createPlan({ name: 'Privé' });
  assert.deepEqual(await bob.listPlans(), []);
  const joined = await bob.joinPlan(p.id);
  assert.deepEqual(joined.memberIds, ['alice', 'bob']);
  assert.deepEqual((await bob.listPlans()).map((x) => x.name), ['Privé']);
  await bob.joinPlan(p.id); // idempotent
  assert.deepEqual(docs.get(`plans/${p.id}`).memberIds, ['alice', 'bob']);
  // saveMeta ne peut pas changer l'appartenance
  await bob.saveMeta(p.id, { name: 'X', ownerId: 'bob', memberIds: ['bob'] });
  assert.equal(docs.get(`plans/${p.id}`).ownerId, 'alice');
  assert.deepEqual(docs.get(`plans/${p.id}`).memberIds, ['alice', 'bob']);
  // la géométrie est stockée en texte (Firestore refuse les tableaux imbriqués)
  await alice.putFeature(p.id, { type: 'Feature', properties: { id: 'l', kind: 'line' }, geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } });
  assert.equal(typeof docs.get(`plans/${p.id}/features/l`).geometry, 'string');
});

test('Firestore : écriture refusée sans connexion', async () => {
  const { fs, db } = createFakeFirestore();
  const store = createFirestoreStore({ db, fs, auth: { user: null } });
  await assert.rejects(() => store.createPlan({ name: 'x' }), /Connexion requise/);
  await assert.rejects(() => store.listPlans(), /Connexion requise/);
});

test('auth locale : identifiant stable par appareil, pas de connexion', async () => {
  const storage = fakeStorage();
  const a = createLocalAuth(storage), b = createLocalAuth(storage);
  assert.equal(a.user.id, b.user.id);
  assert.equal(a.capabilities.signIn, false);
  assert.equal((await a.ready).anonymous, true);
});

test('auth Firebase : état, connexion par mot de passe et Google, déconnexion', async () => {
  let emit; const calls = [];
  const fa = {
    onAuthStateChanged: (_a, cb) => { emit = cb; },
    GoogleAuthProvider: class {},
    signInWithPopup: async () => { calls.push('popup'); return { user: { uid: 'g1', displayName: 'Martin', email: 'm@x.fr' } }; },
    signInWithEmailAndPassword: async (_a, e) => { calls.push(`login:${e}`); return { user: { uid: 'p1', email: e } }; },
    createUserWithEmailAndPassword: async (_a, e) => { calls.push(`create:${e}`); return { user: { uid: 'p2', email: e } }; },
    signOut: async () => { calls.push('out'); emit(null); },
  };
  const auth = createFirebaseAuth({ authInstance: {}, fa });
  const seen = []; auth.onChange((u) => seen.push(u?.id ?? null));
  emit(null);
  assert.equal(await auth.ready, null);
  assert.deepEqual(auth.capabilities.methods, ['google', 'password']);
  assert.equal((await auth.signIn({ method: 'password', email: 'a@b.fr', password: 'secret' })).id, 'p1');
  assert.equal((await auth.signIn({ method: 'password', email: 'n@b.fr', password: 'secret', create: true })).id, 'p2');
  const g = await auth.signIn({ method: 'google' });
  assert.deepEqual([g.id, g.name], ['g1', 'Martin']);
  await auth.signOut();
  assert.equal(auth.user, null);
  assert.deepEqual(calls, ['login:a@b.fr', 'create:n@b.fr', 'popup', 'out']);
  assert.deepEqual(createFirebaseAuth({ authInstance: {}, fa, popup: false }).capabilities.methods, ['password']);
  assert.match(authErrorMessage({ code: 'auth/invalid-credential' }), /incorrect/);
});

test('registre : configuration, hébergement personnalisé, repli en local', async () => {
  assert.deepEqual(readConfig({}), { backend: 'local', firebase: null });
  assert.equal(readConfig({ VITE_FENCY_BACKEND: 'firebase', VITE_FIREBASE_CONFIG: '{"projectId":"p"}' }).firebase.projectId, 'p');
  assert.equal(readConfig({ VITE_FIREBASE_CONFIG: '{pas du json' }).firebase, null);

  registerBackend('maison', async () => ({ name: 'maison', auth: {}, store: {} }));
  assert.equal((await createBackend({ backend: 'maison' })).name, 'maison');

  registerBackend('casse', async () => { throw new Error('serveur injoignable'); });
  const warn = console.warn; console.warn = () => {};
  const fb = await createBackend({ backend: 'casse' });
  const unknown = await createBackend({ backend: 'nexistepas' });
  console.warn = warn;
  assert.equal(fb.name, 'local'); assert.match(fb.fallback, /injoignable/);
  assert.equal(unknown.name, 'local');
  fb.store.close(); unknown.store.close();
});
