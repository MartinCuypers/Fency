/**
 * Registre des hébergements. Chacun fournit { name, auth, store } conformes aux
 * contrats de types.js. Le choix se fait à la compilation :
 *
 *   VITE_FENCY_BACKEND=local      (défaut) stockage sur l'appareil, sans compte
 *   VITE_FENCY_BACKEND=firebase   Firestore + Firebase Auth ; VITE_FIREBASE_CONFIG='{"apiKey":…}'
 *
 * Pour en ajouter un : registerBackend('monserveur', async (cfg) => ({ name, auth, store })).
 */
const registry = new Map();

export function registerBackend(name, factory) { registry.set(name, factory); }

registerBackend('local', async () => {
  const [{ createLocalAuth }, { createLocalStore }] = await Promise.all([import('./local/auth.js'), import('./local/store.js')]);
  const auth = createLocalAuth();
  return { name: 'local', auth, store: await createLocalStore({ auth }) };
});

registerBackend('firebase', async (cfg) => (await import('./firebase/index.js')).createFirebaseBackend(cfg));

/** Lit la configuration de compilation (variables VITE_*). */
export function readConfig(env) {
  let firebase = null;
  try { firebase = env.VITE_FIREBASE_CONFIG ? JSON.parse(env.VITE_FIREBASE_CONFIG) : null; } catch { /* JSON invalide */ }
  return { backend: env.VITE_FENCY_BACKEND || 'local', firebase };
}

/**
 * Crée l'hébergement demandé. En cas d'échec (configuration absente, SDK indisponible),
 * retombe sur le mode local pour que l'application reste utilisable.
 * @returns {Promise<{name: string, auth: import('./types.js').AuthProvider, store: import('./types.js').PlanStore, fallback?: string}>}
 */
export async function createBackend(cfg) {
  const factory = registry.get(cfg.backend);
  if (factory) {
    try { return await factory(cfg); } catch (e) {
      if (cfg.backend === 'local') throw e;
      console.warn(`[fency] hébergement « ${cfg.backend} » indisponible, repli en local :`, e);
      return { ...(await registry.get('local')(cfg)), fallback: String(e?.message ?? e) };
    }
  }
  console.warn(`[fency] hébergement inconnu « ${cfg.backend} », repli en local`);
  return { ...(await registry.get('local')(cfg)), fallback: `hébergement inconnu : ${cfg.backend}` };
}
