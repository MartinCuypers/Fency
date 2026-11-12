# Architecture : stockage et authentification modulables

L'application ne dépend d'aucun hébergeur. Elle parle à deux interfaces, définies dans
`src/backends/types.js` :

- **`AuthProvider`** : qui est l'utilisateur (`user`, `onChange`, `signIn`, `signOut`, `capabilities`).
- **`PlanStore`** : où sont les plans (`listPlans`, `createPlan`, `loadPlan`, `saveMeta`, `deletePlan`,
  `putFeature`, `deleteFeature`, `subscribePlan`, `joinPlan`, `capabilities`).

```
 carte (main.js) ── session.js ── PlanStore ──┬─ local/store.js      IndexedDB, sans compte (démo / gratuit)
                                  AuthProvider ├─ firebase/store.js   Firestore, temps réel, partage
                                               └─ …                   autre hébergeur
```

| Couche | Fichier | Rôle |
|---|---|---|
| Interface | `src/main.js` | carte, dessin ; ignore où les données sont stockées |
| Session | `src/session.js` | regroupe les écritures, applique les changements distants |
| Contrats | `src/backends/types.js` | interfaces `AuthProvider` et `PlanStore` |
| Registre | `src/backends/index.js` | choix de l'hébergement, repli en local |
| Adaptateurs | `src/backends/local/`, `src/backends/firebase/` | implémentations |

## Modèle de données

Un plan = des métadonnées (nom, paramètres, membres) + des **éléments stockés séparément**
(un champ ou une clôture = un enregistrement, avec un identifiant stable). Deux personnes qui
modifient deux clôtures différentes ne s'écrasent pas. Sur le même élément, la dernière écriture gagne.

Chaque écriture porte l'identifiant du client (`by`) : un magasin ne renvoie jamais à un client
l'écho de ses propres écritures. C'est ce qui évite les boucles de synchronisation.

## Choisir l'hébergement

À la compilation, par variables d'environnement (fichier `.env.local` en développement,
variables du dépôt GitHub pour les déploiements) :

```bash
VITE_FENCY_BACKEND=local            # défaut : sur l'appareil
VITE_FENCY_BACKEND=firebase
VITE_FIREBASE_CONFIG='{"apiKey":"…","authDomain":"…","projectId":"…","appId":"…"}'
VITE_FENCY_PUBLIC_URL=https://martincuypers.github.io/Fency/   # liens de partage depuis l'appli Android
```

Le SDK Firebase n'est téléchargé que si cet hébergement est choisi. Si l'hébergement en ligne
échoue au démarrage, l'application retombe sur le stockage local.

### Mettre en service Firebase

1. Créer un projet sur console.firebase.google.com, y ajouter une application Web et copier sa configuration.
2. Authentication : activer « Google » et « E-mail/Mot de passe » ; ajouter le domaine du site aux domaines autorisés.
3. Firestore : créer la base, puis coller `firebase/firestore.rules` dans l'onglet Règles.
4. Définir les variables ci-dessus et recompiler.

La configuration web Firebase n'est pas un secret : la sécurité repose sur les règles Firestore.
Dans l'application Android (WebView), la connexion Google par fenêtre est refusée par Google :
seule la connexion par e-mail et mot de passe y est proposée.

## Ajouter un autre hébergement (Supabase, PocketBase, serveur maison…)

1. Écrire `src/backends/<nom>/auth.js` et `store.js` conformes aux contrats.
2. Le déclarer : `registerBackend('<nom>', async (cfg) => ({ name: '<nom>', auth, store }))` dans `src/backends/index.js`.
3. Le valider avec la suite de contrat : dans `tests/stores.test.js`,
   `runStoreContract('<nom>', async () => ({ a, b, cleanup }))` où `a` et `b` sont deux clients
   branchés sur les mêmes données. Tout magasin qui passe cette suite fonctionne avec l'application.

Authentification et stockage sont indépendants : on peut combiner, par exemple, une authentification
d'entreprise (OIDC) avec Firestore, en fournissant un `AuthProvider` dont `user.id` est l'identifiant
attendu par les règles du magasin.

## Offre gratuite / payante

`capabilities` décrit ce que l'hébergement permet (`sharing`, `realtime`, `signIn`). L'interface
masque d'elle-même le partage et le compte quand ils ne sont pas disponibles : la version locale
sert de démo ou d'offre gratuite, la version en ligne d'offre collaborative.

## Tests

- `tests/store-contract.js` : contrat commun, exécuté sur le stockage en mémoire, IndexedDB et l'adaptateur
  Firestore (avec un faux SDK en mémoire, `tests/fake-firestore.js`).
- `tests/session.test.js` : regroupement des écritures, changement de plan, deux clients sur un même plan.

L'adaptateur Firestore et les règles n'ont pas encore été exécutés contre un vrai projet Firebase.
