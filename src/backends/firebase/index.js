// Chargé à la demande : le SDK Firebase n'est pas téléchargé en mode local.
import { initializeApp } from 'firebase/app';
import * as fs from 'firebase/firestore';
import * as fa from 'firebase/auth';
import { createFirestoreStore } from './store.js';
import { createFirebaseAuth } from './auth.js';

/**
 * @param {Object} cfg
 * @param {Object} cfg.firebase   configuration web du projet Firebase (apiKey, projectId…)
 * @param {boolean} [cfg.webview] application Android : pas de connexion Google par fenêtre
 */
export async function createFirebaseBackend(cfg) {
  if (!cfg.firebase?.projectId) throw new Error('Configuration Firebase manquante (VITE_FIREBASE_CONFIG)');
  const app = initializeApp(cfg.firebase);
  let db;
  try {
    // cache local persistant : le plan reste consultable et modifiable sans réseau dans les champs
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    db = fs.getFirestore(app);
  }
  const auth = createFirebaseAuth({ authInstance: fa.getAuth(app), fa, popup: !cfg.webview });
  const store = createFirestoreStore({ db, fs, auth });
  return { name: 'firebase', auth, store };
}
