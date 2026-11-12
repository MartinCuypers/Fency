import { uid } from '../types.js';

/**
 * Authentification « locale » : pas de compte, un utilisateur anonyme par appareil.
 * @returns {import('../types.js').AuthProvider}
 */
export function createLocalAuth(storage = globalThis.localStorage) {
  let id = null;
  try { id = storage?.getItem('fency.deviceId'); } catch { /* stockage indisponible */ }
  if (!id) {
    id = 'local-' + uid();
    try { storage?.setItem('fency.deviceId', id); } catch { /* idem */ }
  }
  const user = { id, name: 'Cet appareil', email: null, anonymous: true };
  return {
    capabilities: { signIn: false, methods: [] },
    ready: Promise.resolve(user),
    get user() { return user; },
    onChange(cb) { cb(user); return () => {}; },
    async signIn() { throw new Error('Pas de compte en mode local'); },
    async signOut() {},
  };
}
