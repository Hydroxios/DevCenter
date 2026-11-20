import { memo } from "react";

/** Positions [début, fin[ des occurrences de `needle` (déjà en minuscules) dans `text`, sans tenir compte de la casse. */
export function findMatches(text: string, needle: string): [number, number][] {
  if (!needle) return [];
  const hay = text.toLowerCase();
  const out: [number, number][] = [];
  let at = hay.indexOf(needle);
  while (at !== -1) {
    out.push([at, at + needle.length]);
    at = hay.indexOf(needle, at + needle.length);
  }
  return out;
}

/**
 * Texte dont les occurrences de `query` sont surlignées. `active` : indice (dans la ligne) de
 * l'occurrence courante, mise en avant et repérée par `data-active-match` pour le défilement.
 */
export const Highlight = memo(function Highlight({ text, query, active = -1 }: { text: string; query: string; active?: number }) {
  const matches = findMatches(text, query.toLowerCase());
  if (matches.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let last = 0;
  matches.forEach(([start, end], i) => {
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <mark
        key={start}
        data-active-match={i === active || undefined}
        className={
          i === active
            ? "rounded-sm bg-primary px-px text-primary-foreground"
            : "rounded-sm bg-primary/25 px-px text-inherit"
        }
      >
        {text.slice(start, end)}
      </mark>,
    );
    last = end;
  });
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
});
