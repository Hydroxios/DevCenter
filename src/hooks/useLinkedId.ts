import { useEffect } from "react";
import { useSearchParams } from "react-router";

/**
 * Lien profond `?<param>=<id>` (depuis le Journal…) : sélectionne l'élément puis retire le
 * paramètre, la sélection vit ensuite normalement.
 */
export function useLinkedId(param: string, select: (id: number) => void) {
  const [params, setParams] = useSearchParams();
  const linked = Number(params.get(param)) || null;
  useEffect(() => {
    if (linked === null) return;
    select(linked);
    setParams(
      (p) => {
        p.delete(param);
        return p;
      },
      { replace: true },
    );
    // `select` change à chaque rendu : seul le paramètre déclenche la sélection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, param, setParams]);
}
