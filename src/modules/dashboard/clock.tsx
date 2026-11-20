// Widget Horloge : heure et date locales, chaque élément pouvant être masqué.

import { useEffect, useState } from "react";

import { clockOf } from "./config";
import type { WidgetSettings } from "./config";

/** Numéro de semaine ISO 8601. */
function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
}

/** Heure courante, rafraîchie à chaque seconde (ou minute) pile. */
function useNow(everySecond: boolean) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: number;
    const tick = () => {
      const d = new Date();
      setNow(d);
      const step = everySecond ? 1000 - d.getMilliseconds() : 60000 - (d.getSeconds() * 1000 + d.getMilliseconds());
      timer = window.setTimeout(tick, step + 5);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [everySecond]);
  return now;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Taille de police qui fait tenir `chars` caractères à chasse fixe dans la largeur, plafonnée en hauteur. */
const fitFont = (chars: number, maxCqh: number, min: string, max: string) =>
  `clamp(${min}, min(${(100 / (Math.max(chars, 1) * 0.62)).toFixed(2)}cqw, ${maxCqh}cqh), ${max})`;

export function ClockBody({ settings }: { settings: WidgetSettings }) {
  const c = clockOf(settings);
  const now = useNow(c.time && c.seconds);

  const pad = (n: number) => String(n).padStart(2, "0");
  let time = "";
  let period = "";
  if (c.time) {
    const h = now.getHours();
    const hh = c.hour12 ? pad(h % 12 || 12) : pad(h);
    time = `${hh}:${pad(now.getMinutes())}${c.seconds ? `:${pad(now.getSeconds())}` : ""}`;
    if (c.hour12) period = h < 12 ? "AM" : "PM";
  }

  let date = "";
  if (c.date) {
    if (c.dateStyle === "short") {
      date = [pad(now.getDate()), pad(now.getMonth() + 1), ...(c.year ? [String(now.getFullYear())] : [])].join("/");
      if (c.weekday) date = `${capitalize(now.toLocaleDateString("fr-FR", { weekday: "short" }))} ${date}`;
    } else {
      date = capitalize(
        now.toLocaleDateString("fr-FR", {
          weekday: c.weekday ? "long" : undefined,
          day: "numeric",
          month: "long",
          year: c.year ? "numeric" : undefined,
        }),
      );
    }
  } else if (c.weekday) {
    date = capitalize(now.toLocaleDateString("fr-FR", { weekday: "long" }));
  }

  const extras = [c.week && `Semaine ${isoWeek(now)}`, c.zone && Intl.DateTimeFormat().resolvedOptions().timeZone].filter(Boolean);

  if (!time && !date && extras.length === 0) {
    return <p className="m-auto text-sm text-muted-foreground">Rien à afficher : activez un élément dans les réglages.</p>;
  }

  return (
    <div className="flex h-full min-w-0 flex-col items-center justify-center gap-[3cqh] text-center">
      {time && (
        <p
          className="font-mono leading-none font-semibold tracking-tight text-primary tabular-nums"
          style={{ fontSize: fitFont(time.length + (period ? 1.6 : 0), date || extras.length ? 48 : 70, "1.25rem", "9rem") }}
        >
          {time}
          {period && <span className="ml-[0.15em] text-[0.4em] font-normal text-muted-foreground">{period}</span>}
        </p>
      )}
      {date && (
        <p
          className={time ? "leading-tight text-muted-foreground" : "font-semibold leading-tight"}
          style={{ fontSize: fitFont(date.length * 0.85, time ? 14 : 40, "0.8rem", time ? "2rem" : "5rem") }}
        >
          {date}
        </p>
      )}
      {extras.length > 0 && <p className="meta">{extras.join(" · ")}</p>}
    </div>
  );
}
