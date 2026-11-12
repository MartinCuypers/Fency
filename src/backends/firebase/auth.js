/**
 * AuthProvider sur Firebase Authentication (Google et e-mail/mot de passe).
 * Les fonctions du SDK sont injectées (`fa`) pour les tests.
 *
 * @param {Object} o
 * @param {*} o.authInstance           getAuth(app)
 * @param {Object} o.fa                fonctions du SDK firebase/auth
 * @param {boolean} [o.popup]          false dans une WebView Android : Google y refuse la connexion par fenêtre
 * @returns {import('../types.js').AuthProvider}
 */
export function createFirebaseAuth({ authInstance, fa, popup = true }) {
  const toUser = (u) => u && ({
    id: u.uid, name: u.displayName || u.email || 'Utilisateur', email: u.email ?? null, anonymous: !!u.isAnonymous,
  });
  let user = null;
  const listeners = new Set();
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  fa.onAuthStateChanged(authInstance, (u) => {
    user = toUser(u);
    resolveReady(user);
    listeners.forEach((cb) => cb(user));
  });

  return {
    capabilities: { signIn: true, methods: popup ? ['google', 'password'] : ['password'] },
    ready,
    get user() { return user; },
    onChange(cb) { listeners.add(cb); if (user !== undefined) cb(user); return () => listeners.delete(cb); },

    async signIn({ method, email, password, create = false }) {
      let cred;
      if (method === 'google') cred = await fa.signInWithPopup(authInstance, new fa.GoogleAuthProvider());
      else if (method === 'password') {
        cred = create
          ? await fa.createUserWithEmailAndPassword(authInstance, email, password)
          : await fa.signInWithEmailAndPassword(authInstance, email, password);
      } else throw new Error(`Méthode de connexion inconnue : ${method}`);
      user = toUser(cred.user);
      return user;
    },

    async signOut() { await fa.signOut(authInstance); },
  };
}

/** Message lisible pour les erreurs courantes de Firebase Auth. */
export function authErrorMessage(e) {
  const code = e?.code ?? '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'E-mail ou mot de passe incorrect.';
  if (code.includes('email-already-in-use')) return 'Un compte existe déjà avec cet e-mail.';
  if (code.includes('weak-password')) return 'Mot de passe trop court (6 caractères minimum).';
  if (code.includes('invalid-email')) return 'Adresse e-mail invalide.';
  if (code.includes('popup-closed') || code.includes('cancelled')) return 'Connexion annulée.';
  if (code.includes('network')) return 'Pas de réseau.';
  if (code.includes('api-key') || code.includes('configuration')) return 'Configuration Firebase invalide (clé du projet).';
  return e?.message ?? 'Connexion impossible.';
}
