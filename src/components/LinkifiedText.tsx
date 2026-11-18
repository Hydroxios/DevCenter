import { memo } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { isTauri } from "@/services/tauri";

/**
 * Adresses reconnues dans un texte : http(s)://… ainsi que localhost:port / 127.0.0.1:port sans
 * schéma (fréquents dans la sortie des serveurs de dev).
 */
const URL_RE = /\b(?:https?:\/\/|(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+)[^\s"'<>`]*/g;
/** Ponctuation de fin de phrase qui n'appartient pas à l'adresse. */
const TRAILING = /[.,;:!?)\]}]+$/;

function open(url: string) {
  // 0.0.0.0 n'est pas joignable dans un navigateur : on vise localhost.
  const target = (/^https?:\/\//.test(url) ? url : `http://${url}`).replace("://0.0.0.0", "://localhost");
  if (isTauri()) openUrl(target).catch(() => {});
  else window.open(target, "_blank", "noopener");
}

/** Une ligne de texte dont les adresses sont cliquables (ouvertes dans le navigateur par défaut). */
export const LinkifiedLine = memo(function LinkifiedLine({ text }: { text: string }) {
  if (!text.includes("http") && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(text)) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0];
    const url = raw.replace(TRAILING, "");
    const start = m.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <a
        key={start}
        href={url}
        onClick={(e) => {
          e.preventDefault();
          open(url);
        }}
        title={`Ouvrir ${url}`}
        className="cursor-pointer text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      >
        {url}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
});
