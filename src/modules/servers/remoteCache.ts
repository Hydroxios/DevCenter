/**
 * Dernières données distantes connues, par serveur (métriques, services, conteneurs).
 * Revenir sur un serveur affiche immédiatement ces valeurs ; la mise à jour se fait ensuite
 * en arrière-plan. Vit le temps de la session de l'application.
 */
const cache = new Map<string, unknown>();

export const remoteCache = {
  get<T>(key: string): T | undefined {
    return cache.get(key) as T | undefined;
  },
  set<T>(key: string, value: T) {
    cache.set(key, value);
  },
  /** Oublie tout ce qui concerne un serveur (supprimé ou modifié). */
  forget(serverId: number) {
    for (const k of [...cache.keys()]) if (k.endsWith(`:${serverId}`)) cache.delete(k);
  },
};
