import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { api } from "@/services/tauri";
import type { Project, ProjectDetails } from "@/types";

/**
 * Projets + détails (Git, frameworks, scripts).
 *
 * Les données restent en mémoire entre deux visites de la page et sont gardées sur disque
 * (localStorage) : la liste s'affiche aussitôt, puis se met à jour en arrière-plan. Côté Rust,
 * le statut Git est lui-même en cache (relu quand le dépôt change), donc la mise à jour est
 * quasi gratuite.
 */
const STORAGE_KEY = "devcenter.projects.cache.v1";

interface Snapshot {
  projects: Project[] | null;
  details: Record<number, ProjectDetails>;
}

function loadSnapshot(): Snapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Snapshot;
      if (Array.isArray(s.projects) && s.details && typeof s.details === "object") return s;
    }
  } catch {
    /* cache illisible : on repart de zéro */
  }
  return { projects: null, details: {} };
}

const cache: Snapshot = loadSnapshot();
let saveTimer: number | undefined;

function persist() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch {
      /* stockage plein ou indisponible : le cache mémoire suffit */
    }
  }, 500);
}

export function useProjects() {
  const [projects, setProjectsState] = useState<Project[] | null>(cache.projects);
  const [details, setDetailsState] = useState<Record<number, ProjectDetails>>(cache.details);
  const [error, setError] = useState<string | null>(null);

  const setOne = useCallback((d: ProjectDetails) => {
    cache.details = { ...cache.details, [d.id]: d };
    setDetailsState(cache.details);
    persist();
  }, []);

  const loadDetails = useCallback(
    (list: Project[]) => {
      for (const p of list) {
        if (!p.exists) continue;
        api.projects.details(p.id).then(setOne).catch(() => {});
      }
    },
    [setOne],
  );

  const apply = useCallback(
    (list: Project[]) => {
      cache.projects = list;
      // Oublie les détails des projets retirés.
      const ids = new Set(list.map((p) => p.id));
      cache.details = Object.fromEntries(Object.entries(cache.details).filter(([id]) => ids.has(Number(id))));
      setProjectsState(list);
      setDetailsState(cache.details);
      persist();
      setError(null);
      loadDetails(list);
    },
    [loadDetails],
  );

  const refresh = useCallback(async () => {
    try {
      apply(await api.projects.list());
    } catch (e) {
      setError(String(e));
    }
  }, [apply]);

  /** Bouton « Actualiser » : relit vraiment le dépôt (contourne le cache Rust). */
  const refreshOne = useCallback(
    (id: number) => {
      api.projects.details(id, true).then(setOne).catch(() => {});
    },
    [setOne],
  );

  useEffect(() => {
    refresh();
    // Retour sur la fenêtre (après un commit dans l'IDE…) : le cache Rust ne relit que les
    // dépôts qui ont changé ou dont le statut a plus de 30 s.
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    // Projet importé ou cloné depuis le téléphone.
    const unlisten = listen("projects://changed", () => refresh());
    return () => {
      window.removeEventListener("focus", onFocus);
      unlisten.then((f) => f());
    };
  }, [refresh]);

  return { projects, details, error, setError, apply, refresh, refreshOne, setOne };
}
