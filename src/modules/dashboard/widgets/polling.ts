// Interrogation des widgets ajoutés (serveurs, GitHub, automatisations). Fichier sans composant :
// le Fast Refresh de Vite reste actif sur les fichiers de widgets.

import { useCallback, useEffect, useRef, useState } from "react";

import { isTauri } from "@/services/tauri";

/** Dernière valeur par clé, gardée pour la session : retour sur le tableau = affichage immédiat. */
const cache = new Map<string, { at: number; data: unknown }>();

export function cached<T>(key: string) {
  return cache.get(key) as { at: number; data: T } | undefined;
}

/**
 * Interroge `fetcher` toutes les `intervalMs`, seulement quand la fenêtre est visible et tant que
 * le widget est monté. La valeur en cache encore fraîche évite une relecture au montage ;
 * `refresh()` relit tout de suite.
 */
export function useWidgetPolling<T>(key: string, fetcher: () => Promise<T>, intervalMs: number) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>(() => {
    const hit = cached<T>(key);
    return { data: hit?.data ?? null, error: null, loading: !hit };
  });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const refreshRef = useRef<() => void>(() => {});
  const enabled = isTauri();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | undefined;

    const tick = async (force = false) => {
      if (force || document.visibilityState === "visible") {
        if (!cancelled) setState((s) => ({ ...s, loading: true }));
        try {
          const data = await fetcherRef.current();
          cache.set(key, { at: Date.now(), data });
          if (!cancelled) setState({ data, error: null, loading: false });
        } catch (e) {
          if (!cancelled) setState((s) => ({ ...s, error: String(e), loading: false }));
        }
      }
      if (!cancelled) timer = window.setTimeout(tick, intervalMs);
    };
    const onVisible = () => {
      const hit = cached<T>(key);
      if (document.visibilityState === "visible" && (!hit || Date.now() - hit.at >= intervalMs)) {
        window.clearTimeout(timer);
        tick();
      }
    };
    const hit = cached<T>(key);
    timer = window.setTimeout(tick, hit ? Math.max(0, intervalMs - (Date.now() - hit.at)) : 0);
    refreshRef.current = () => {
      window.clearTimeout(timer);
      tick(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, intervalMs, enabled]);

  const refresh = useCallback(() => refreshRef.current(), []);
  return { ...state, refresh };
}

/** Lecture / écriture tolérantes d'une préférence locale (JSON). */
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : préférence non conservée */
  }
}
