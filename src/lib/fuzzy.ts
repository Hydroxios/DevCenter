/**
 * Recherche floue minimale (sans dépendance) : les caractères de la requête doivent apparaître
 * dans l'ordre. Le score favorise les correspondances consécutives, en début de mot et en tête.
 */

/** Minuscules sans accents, pour que « systeme » trouve « Système ». */
export function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export interface FuzzyMatch {
  score: number;
  /** Indices des caractères correspondants dans le texte. */
  indices: number[];
}

const isBoundary = (text: string, i: number) => i === 0 || /[\s\-_/.:›@]/.test(text[i - 1]);

/** `null` si la requête ne correspond pas. La requête doit déjà être normalisée et sans espaces superflus. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] };
  const t = normalize(text);

  // Sous-chaîne exacte : le meilleur cas, surtout en début de mot.
  const sub = t.indexOf(query);
  if (sub >= 0) {
    const indices = Array.from({ length: query.length }, (_, k) => sub + k);
    const score = 100 + query.length * 4 + (sub === 0 ? 40 : isBoundary(t, sub) ? 20 : 0) - Math.min(sub, 20);
    return { score, indices };
  }

  // Sinon : sous-séquence, en préférant les débuts de mot.
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < query.length; qi++) {
    const c = query[qi];
    if (c === " ") continue;
    // Cherche d'abord ce caractère en début de mot, sinon la prochaine occurrence.
    let found = -1;
    for (let j = ti; j < t.length; j++) {
      if (t[j] === c && isBoundary(t, j)) {
        found = j;
        break;
      }
    }
    const next = t.indexOf(c, ti);
    if (next < 0) return null;
    // On ne saute vers un début de mot que si on ne casse pas une suite consécutive.
    if (found < 0 || next === prev + 1) found = next;
    score += found === prev + 1 ? 8 : isBoundary(t, found) ? 6 : 1;
    score -= Math.min(found - ti, 6) * 0.5;
    indices.push(found);
    prev = found;
    ti = found + 1;
  }
  return { score, indices };
}

/**
 * Correspondance d'une requête multi-mots : chaque mot doit trouver sa place dans le libellé
 * ou dans les mots-clés. Les indices ne concernent que le libellé (pour le surlignage).
 */
export function matchItem(query: string, label: string, keywords: string): FuzzyMatch | null {
  const q = normalize(query).trim();
  if (!q) return { score: 0, indices: [] };
  // Requête entière sur le libellé : surlignage le plus lisible.
  const whole = fuzzyMatch(q.replace(/\s+/g, " "), label);
  if (whole) return { score: whole.score + 10, indices: whole.indices };

  let score = 0;
  const indices = new Set<number>();
  for (const word of q.split(/\s+/)) {
    const onLabel = fuzzyMatch(word, label);
    const onKeywords = fuzzyMatch(word, keywords);
    if (!onLabel && !onKeywords) return null;
    if (onLabel && (!onKeywords || onLabel.score >= onKeywords.score - 5)) {
      score += onLabel.score;
      onLabel.indices.forEach((i) => indices.add(i));
    } else {
      score += onKeywords!.score * 0.7;
    }
  }
  return { score, indices: [...indices].sort((a, b) => a - b) };
}
