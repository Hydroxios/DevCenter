import { useEffect, useRef, useState } from "react";

/**
 * Appelle `fetcher` à intervalle régulier, uniquement quand la fenêtre est visible
 * (aucun appel IPC quand DevCenter est réduit dans la barre système).
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  enabled = true,
  options: { initial?: T | null; onData?: (data: T) => void } = {},
) {
  const [data, setData] = useState<T | null>(options.initial ?? null);
  const onDataRef = useRef(options.onData);
  onDataRef.current = options.onData;
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    let cancelled = false;

    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const result = await fetcherRef.current();
          if (!cancelled) {
            setData(result);
            setError(null);
            onDataRef.current?.(result);
          }
        } catch (e) {
          if (!cancelled) setError(String(e));
        }
      }
      if (!cancelled) timer = window.setTimeout(tick, intervalMs);
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        window.clearTimeout(timer);
        tick();
      }
    };

    tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, enabled]);

  return { data, error };
}
