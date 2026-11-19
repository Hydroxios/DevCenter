import { Check, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ACCENTS, hasHistory } from "./config";
import type { Accent, ChartStyle, HistoryWindow, ProcessSort, WidgetSettings } from "./config";
import { WIDGETS } from "./registry";
import type { WidgetType } from "./registry";
import { HistoryChart } from "./widgets";

const ACCENT_LABELS: Record<Accent, string> = {
  cyan: "Cyan",
  green: "Vert",
  amber: "Ambre",
  violet: "Violet",
  rose: "Rose",
  blue: "Bleu",
};

/** Groupe de boutons à choix unique. */
function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex w-fit flex-wrap rounded-lg border bg-secondary p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-3 py-1 text-xs transition-colors",
            value === o.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Données d'exemple pour l'aperçu des styles de graphique. */
const SAMPLE = [32, 38, 30, 45, 58, 52, 64, 48, 40, 55, 70, 62, 50, 44, 58, 66, 72, 60, 52, 47];

const CHART_STYLES: { value: ChartStyle; label: string }[] = [
  { value: "area", label: "Aire" },
  { value: "smooth", label: "Lissé" },
  { value: "line", label: "Ligne" },
  { value: "step", label: "Escalier" },
  { value: "bars", label: "Barres" },
  { value: "gauge", label: "Jauge" },
  { value: "none", label: "Aucun" },
];

/** Choix du style de graphique : une tuile par style, avec un aperçu. */
function ChartPicker({ value, onChange }: { value: ChartStyle; onChange: (v: ChartStyle) => void }) {
  return (
    <div className="grid grid-cols-4 gap-2" role="radiogroup">
      {CHART_STYLES.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "grid gap-1.5 rounded-lg border p-1.5 text-xs transition-colors",
              active ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:border-primary/50 hover:text-foreground",
            )}
          >
            <span className="flex h-8 items-end">
              {o.value === "gauge" ? (
                <span className="mb-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <span className="block h-full w-3/5 rounded-full bg-primary" />
                </span>
              ) : o.value === "none" ? (
                <span className="flex h-full w-full items-center justify-center rounded-sm border border-dashed border-border text-[10px]">—</span>
              ) : (
                <HistoryChart history={SAMPLE} points={SAMPLE.length} variant={o.value} className="h-full" />
              )}
            </span>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="eyebrow">{label}</span>
      {children}
    </div>
  );
}

/** Personnalisation d'un widget : les changements s'appliquent immédiatement. */
export function WidgetSettingsDialog({
  type,
  settings,
  onChange,
  onReset,
  onClose,
}: {
  type: WidgetType | null;
  settings: WidgetSettings;
  onChange: (patch: Partial<WidgetSettings>) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const def = type ? WIDGETS[type] : null;
  const options: readonly string[] = def && "options" in def ? def.options : [];

  return (
    <Dialog open={type !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Personnaliser « {settings.title || def?.title} »</DialogTitle>
          <DialogDescription>Les changements s'appliquent tout de suite au tableau de bord.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          <Field label="Titre">
            <Input
              value={settings.title ?? ""}
              placeholder={def?.title}
              onChange={(e) => onChange({ title: e.target.value || undefined })}
              maxLength={40}
            />
          </Field>

          <Field label="Couleur">
            <div className="flex flex-wrap gap-2">
              {ACCENTS.map((a) => {
                const active = (settings.accent ?? "cyan") === a;
                return (
                  <button
                    key={a}
                    type="button"
                    onClick={() => onChange({ accent: a === "cyan" ? undefined : a })}
                    title={ACCENT_LABELS[a]}
                    aria-label={ACCENT_LABELS[a]}
                    aria-pressed={active}
                    className={cn(
                      `accent-${a}`,
                      "flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground ring-offset-2 ring-offset-background transition",
                      active ? "ring-2 ring-primary" : "opacity-70 hover:opacity-100",
                    )}
                  >
                    {active && <Check className="size-4" />}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="En-tête">
            <Segmented
              value={settings.header === false ? "off" : "on"}
              options={[
                { value: "on", label: "Affiché" },
                { value: "off", label: "Masqué" },
              ]}
              onChange={(v) => onChange({ header: v === "off" ? false : undefined })}
            />
          </Field>

          <Field label="Cadre">
            <Segmented
              value={settings.frame === undefined ? "auto" : settings.frame ? "on" : "off"}
              options={[
                { value: "auto", label: "Par défaut" },
                { value: "on", label: "Affiché" },
                { value: "off", label: "Masqué" },
              ]}
              onChange={(v) => onChange({ frame: v === "auto" ? undefined : v === "on" })}
            />
          </Field>

          {options.includes("window") && hasHistory(settings.chart) && (
            <Field label="Historique">
              <Segmented<HistoryWindow>
                value={settings.window ?? 2}
                options={[
                  { value: 1, label: "1 min" },
                  { value: 2, label: "2 min" },
                  { value: 5, label: "5 min" },
                ]}
                onChange={(v) => onChange({ window: v === 2 ? undefined : v })}
              />
            </Field>
          )}

          {options.includes("chart") && (
            <Field label="Graphique">
              <ChartPicker value={settings.chart ?? "area"} onChange={(v) => onChange({ chart: v === "area" ? undefined : v })} />
            </Field>
          )}

          {options.includes("sort") && (
            <Field label="Trier par">
              <Segmented<ProcessSort>
                value={settings.sort ?? "cpu"}
                options={[
                  { value: "cpu", label: "CPU" },
                  { value: "memory", label: "Mémoire" },
                ]}
                onChange={(v) => onChange({ sort: v === "cpu" ? undefined : v })}
              />
            </Field>
          )}

          {options.includes("count") && (
            <Field label="Nombre de processus">
              <Segmented<number>
                value={settings.count ?? 8}
                options={[5, 8, 12, 20].map((n) => ({ value: n, label: String(n) }))}
                onChange={(v) => onChange({ count: v === 8 ? undefined : v })}
              />
            </Field>
          )}
        </div>

        <DialogFooter className="justify-between">
          <Button variant="ghost" size="sm" onClick={onReset}>
            <RotateCcw /> Valeurs par défaut
          </Button>
          <Button size="sm" onClick={onClose}>
            <Check /> Fermer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
