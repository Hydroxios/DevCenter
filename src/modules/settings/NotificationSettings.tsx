import { Monitor, Smartphone } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";
import type { NotificationCategory, NotificationChannels } from "@/types";

const CATEGORIES: { id: NotificationCategory; label: string; description: string }[] = [
  { id: "automation", label: "Échec d'automatisation", description: "Une automatisation échoue ou dépasse son délai." },
  { id: "script", label: "Script planté", description: "Un script s'arrête avec une erreur sans avoir été arrêté." },
  { id: "workspace", label: "Workspace avec erreurs", description: "Un workspace démarre avec des étapes en échec." },
  { id: "step", label: "Étape « Notifier »", description: "Les étapes Notifier de vos automatisations." },
];

const CHANNELS: { id: keyof NotificationChannels; label: string; icon: typeof Monitor }[] = [
  { id: "desktop", label: "Bureau", icon: Monitor },
  { id: "mobile", label: "Mobile", icon: Smartphone },
];

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span className={cn("inline-block size-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-5.5" : "translate-x-0.5")} />
    </button>
  );
}

/** Canaux par catégorie (notification Windows / push mobile) et discrétion au premier plan. */
export function NotificationSettings() {
  const { settings, update } = useSettings();
  const prefs = settings.notifications;

  const setChannel = (cat: NotificationCategory, channel: keyof NotificationChannels, value: boolean) =>
    update("notifications", { ...prefs, [cat]: { ...prefs[cat], [channel]: value } });

  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-0">
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 gap-y-0">
          <span className="eyebrow pb-3">Événement</span>
          {CHANNELS.map(({ id, label, icon: Icon }) => (
            <span key={id} className="eyebrow flex w-14 items-center justify-center gap-1.5 pb-3">
              <Icon className="size-3.5" /> {label}
            </span>
          ))}
          {CATEGORIES.map((c) => (
            <div key={c.id} className="contents">
              <div className="min-w-0 border-t py-4">
                <p className="text-sm font-medium">{c.label}</p>
                <p className="mt-0.5 truncate text-sm text-muted-foreground" title={c.description}>{c.description}</p>
              </div>
              {CHANNELS.map((ch) => (
                <div key={ch.id} className="flex h-full w-14 items-center justify-center border-t">
                  <Toggle
                    label={`${c.label} : ${ch.label}`}
                    checked={prefs[c.id][ch.id]}
                    onChange={(v) => setChannel(c.id, ch.id, v)}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      </Card>
      <Card className="gap-0">
        <div className="flex items-center justify-between gap-6">
          <div className="min-w-0">
            <p className="text-sm font-medium">Discrétion au premier plan</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Ne pas afficher de notification Windows quand la fenêtre DevCenter est au premier plan (le mobile est toujours prévenu).
            </p>
          </div>
          <Toggle
            label="Ne pas notifier si la fenêtre DevCenter est au premier plan"
            checked={prefs.skipWhenFocused}
            onChange={(v) => update("notifications", { ...prefs, skipWhenFocused: v })}
          />
        </div>
      </Card>
      <p className="px-1 text-xs text-muted-foreground">
        Les notifications Windows proposent « Relancer » et « Voir les logs » ; un clic ouvre l'élément concerné dans DevCenter.
        Windows ne transmet ces clics que tant que la notification est affichée, pas depuis le centre de notifications.
        Le mobile concerne les téléphones appairés ayant activé les notifications (onglet Accès mobile).
      </p>
    </div>
  );
}
