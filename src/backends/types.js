/**
 * Contrats (« ports ») que tout hébergement doit respecter. L'application ne connaît
 * que ces interfaces : ajouter Supabase, PocketBase ou un serveur maison revient à
 * écrire un AuthProvider et un PlanStore, puis à les déclarer dans backends/index.js.
 *
 * Modèle de données
 * -----------------
 * Un plan = des métadonnées + des éléments dessinés (champs, clôtures), stockés
 * SÉPARÉMENT. Deux personnes qui modifient deux clôtures différentes ne s'écrasent
 * donc pas : le dernier qui écrit gagne, mais élément par élément.
 *
 * @typedef {Object} User
 * @property {string} id
 * @property {string} name
 * @property {string|null} email
 * @property {boolean} anonymous   utilisateur local, sans compte
 *
 * @typedef {Object} PlanMeta
 * @property {string} id
 * @property {string} name
 * @property {Object} params        paramètres de génération et de matériel
 * @property {boolean} genActive    clôtures générées affichées
 * @property {string} ownerId
 * @property {string[]} memberIds   utilisateurs autorisés (propriétaire compris)
 * @property {number} updatedAt     millisecondes
 * @property {string} by            identifiant du client auteur de la dernière écriture
 *
 * Élément : Feature GeoJSON dont `properties` contient
 *   { id: string, kind: 'field'|'line', updatedAt: number, by: string }
 * @typedef {Object} PlanFeature
 *
 * @typedef {Object} AuthProvider
 * @property {{signIn: boolean, methods: string[]}} capabilities
 *           signIn=false : pas de compte (mode local) ; methods : 'google', 'password'…
 * @property {Promise<User|null>} ready      résolu quand l'état de connexion initial est connu
 * @property {User|null} user                utilisateur courant
 * @property {(cb: (u: User|null) => void) => (() => void)} onChange
 * @property {(opts: {method: string, email?: string, password?: string, create?: boolean}) => Promise<User>} signIn
 * @property {() => Promise<void>} signOut
 *
 * @typedef {Object} PlanHandlers
 * @property {(meta: PlanMeta) => void} [onMeta]
 * @property {(feature: PlanFeature) => void} [onFeature]           ajout ou modification
 * @property {(featureId: string) => void} [onFeatureRemoved]
 * @property {() => void} [onPlanRemoved]
 *
 * @typedef {Object} PlanStore
 * @property {{realtime: boolean, sharing: boolean}} capabilities
 *           realtime : les autres appareils reçoivent les changements ;
 *           sharing  : un plan peut être rejoint par un autre utilisateur.
 * @property {() => Promise<PlanMeta[]>} listPlans                     plans de l'utilisateur, récents d'abord
 * @property {(init: {name: string, params?: Object, genActive?: boolean}) => Promise<PlanMeta>} createPlan
 * @property {(id: string) => Promise<{meta: PlanMeta, features: PlanFeature[]}|null>} loadPlan
 * @property {(id: string, patch: Partial<PlanMeta>) => Promise<void>} saveMeta
 * @property {(id: string) => Promise<void>} deletePlan
 * @property {(planId: string, feature: PlanFeature) => Promise<void>} putFeature
 * @property {(planId: string, featureId: string) => Promise<void>} deleteFeature
 * @property {(planId: string, handlers: PlanHandlers) => (() => void)} subscribePlan
 *           Ne notifie QUE les changements faits par un autre client (jamais l'écho de ses propres écritures).
 * @property {(id: string) => Promise<PlanMeta|null>} joinPlan         rejoint un plan partagé (lien)
 * @property {() => void} [close]
 */

/** Identifiant aléatoire (plans, éléments, clients). */
export function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  return Array.from({ length: 20 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

/** Copie d'un élément avec ses marqueurs d'écriture. */
export function stamp(feature, clientId, now = Date.now()) {
  return { ...feature, properties: { ...feature.properties, updatedAt: now, by: clientId } };
}
