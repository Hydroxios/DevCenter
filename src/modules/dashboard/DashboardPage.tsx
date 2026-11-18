import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { noCompactor, useContainerWidth } from "react-grid-layout";
import type { Layout, LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { Check, GripVertical, LayoutGrid, Pencil, Plus, RotateCcw, Settings2, X } from "lucide-react";

import { EmptyState, Page, PageMain, PageNotice } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { usePolling } from "@/hooks/usePolling";
import { cn } from "@/lib/utils";
import { api, isTauri } from "@/services/tauri";
import type { SystemInfo } from "@/types";
import { AutoFit, HISTORY_MAX, REFRESH_MS, WIDGETS, isWidgetType } from "./widgets";
import type { DashboardData, WidgetSettings, WidgetType } from "./widgets";
import { WidgetSettingsDialog } from "./WidgetSettingsDialog";

const STORAGE_KEY = "devcenter.dashboard.layout.v1";
const SETTINGS_KEY = "devcenter.dashboard.settings.v1";
const COLS = 12;
/** Le tableau tient toujours dans la fenêtre : 16 lignes dont la hauteur suit celle de l'écran. */
const ROWS = 16;
/** Hauteur minimale d'une ligne (petite fenêtre : les widgets défilent à l'intérieur). */
const MIN_ROW_HEIGHT = 16;
const GAP = 16;
/** Marge intérieure de la zone du tableau, en px. */
const BOARD_PADDING = 24;

/** Disposition d'origine (bouton « Réinitialiser »). */
const DEFAULT_LAYOUT: { i: WidgetType; x: number; y: number }[] = [
  { i: "cpu", x: 0, y: 0 },
  { i: "memory", x: 6, y: 0 },
  { i: "system", x: 9, y: 0 },
  { i: "cores", x: 0, y: 5 },
  { i: "storage", x: 8, y: 5 },
  { i: "workspaces", x: 0, y: 12 },
  { i: "runs", x: 6, y: 12 },
];

/** Complète une position avec la taille par défaut et les limites du widget. */
function withConstraints(item: { i: WidgetType; x: number; y: number; w?: number; h?: number }): LayoutItem {
  const { w, h, minW, minH } = WIDGETS[item.i].size;
  // Ramené dans les limites du tableau (dispositions enregistrées avant ce plafond).
  const cw = Math.min(Math.max(item.w ?? w, minW), COLS);
  const ch = Math.min(Math.max(item.h ?? h, minH), ROWS);
  const x = Math.max(0, Math.min(item.x, COLS - cw));
  const y = Math.max(0, Math.min(item.y, ROWS - ch));
  return { i: item.i, x, y, w: cw, h: ch, minW, minH };
}

const defaultLayout = () => DEFAULT_LAYOUT.map(withConstraints);

function loadLayout(): LayoutItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultLayout();
    const saved = JSON.parse(raw) as { i: string; x: number; y: number; w: number; h: number }[];
    // Les widgets disparus d'une version à l'autre sont ignorés.
    return saved.filter((it) => isWidgetType(it.i)).map((it) => withConstraints(it as Parameters<typeof withConstraints>[0]));
  } catch {
    return defaultLayout();
  }
}

function saveLayout(layout: Layout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))));
  } catch {
    /* stockage indisponible : la disposition ne sera simplement pas conservée */
  }
}

type SettingsMap = Partial<Record<WidgetType, WidgetSettings>>;

function loadSettings(): SettingsMap {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as SettingsMap;
  } catch {
    return {};
  }
}

function saveSettings(settings: SettingsMap) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* stockage indisponible : réglages non conservés */
  }
}

const NO_SETTINGS: WidgetSettings = {};

const push = (prev: number[], v: number) => [...prev, v].slice(-HISTORY_MAX);

/** Première place libre (de haut en bas, de gauche à droite) à la taille par défaut, sinon à la taille minimale. */
function findFreeSpot(layout: LayoutItem[], type: WidgetType) {
  const { w, h, minW, minH } = WIDGETS[type].size;
  return findSpot(layout, w, h) ?? findSpot(layout, minW, minH);
}

function findSpot(layout: LayoutItem[], w: number, h: number) {
  const overlaps = (x: number, y: number) =>
    layout.some((it) => x < it.x + it.w && x + w > it.x && y < it.y + it.h && y + h > it.y);
  for (let y = 0; y + h <= ROWS; y++) {
    for (let x = 0; x + w <= COLS; x++) {
      if (!overlaps(x, y)) return { x, y, w, h };
    }
  }
  return null;
}

/** Habillage commun : en-tête (poignée de déplacement en mode édition), contenu qui remplit la case. */
const WidgetFrame = memo(function WidgetFrame({
  type,
  data,
  settings,
  editing,
  onRemove,
  onConfigure,
}: {
  type: WidgetType;
  data: DashboardData;
  settings: WidgetSettings;
  editing: boolean;
  onRemove: (type: WidgetType) => void;
  onConfigure: (type: WidgetType) => void;
}) {
  const def = WIDGETS[type];
  const Icon = def.icon;
  const title = settings.title || def.title;
  // L'en-tête masqué l'est aussi en édition : l'aperçu est fidèle. Les outils d'édition passent
  // alors dans une petite barre flottante, et tout le widget sert de poignée de déplacement.
  const showHeader = settings.header !== false;
  const bare = !showHeader && "bareWithoutHeader" in def && def.bareWithoutHeader;
  const tools = editing && (
    <>
      <button
        type="button"
        onClick={() => onConfigure(type)}
        className="widget-nodrag flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/15 hover:text-primary"
        title="Personnaliser ce widget"
        aria-label={`Personnaliser le widget ${title}`}
      >
        <Settings2 className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onRemove(type)}
        className="widget-nodrag flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
        title="Retirer ce widget"
        aria-label={`Retirer le widget ${title}`}
      >
        <X className="size-3.5" />
      </button>
    </>
  );
  return (
    <Card
      className={cn(
        // La carte est un conteneur de taille : un widget très bas passe en mode compact (index.css).
        "widget-card relative h-full min-w-0 gap-0 overflow-hidden p-0",
        bare && "border-transparent bg-transparent",
        settings.accent && `accent-${settings.accent}`,
        editing && "border-dashed border-primary/40 shadow-[0_0_0_1px] shadow-primary/10",
      )}
    >
      <div
        className={cn(
          "widget-inner flex h-full min-h-0 flex-col gap-3",
          bare ? "is-bare" : "p-4",
          editing && !showHeader && "widget-handle cursor-grab active:cursor-grabbing",
        )}
      >
        {showHeader && (
          <header className={cn("widget-handle flex items-center gap-2", editing && "cursor-grab active:cursor-grabbing")}>
            {editing && <GripVertical className="-ml-1 size-4 shrink-0 text-muted-foreground" />}
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Icon className="size-3.5" />
            </span>
            <h3 className="eyebrow min-w-[4ch] flex-1 truncate">{title}</h3>
            {editing ? (
              <div className="-mr-1 flex shrink-0 items-center">{tools}</div>
            ) : (
              "aside" in def && def.aside && <div className="min-w-0 shrink-[100] truncate whitespace-nowrap">{def.aside(data, settings)}</div>
            )}
          </header>
        )}
        <div
          className={cn("flex min-h-0 flex-1 flex-col gap-3 overflow-hidden [container-type:size]", editing && "pointer-events-none select-none")}
        >
          {"fit" in def && def.fit === "fill" ? def.render(data, settings) : <AutoFit>{def.render(data, settings)}</AutoFit>}
        </div>
      </div>
      {editing && !showHeader && (
        <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-0.5 rounded-lg border bg-card/95 p-0.5 shadow-md backdrop-blur">
          <GripVertical className="size-3.5 text-muted-foreground" aria-hidden />
          {tools}
        </div>
      )}
    </Card>
  );
});

/** Commandes flottantes en bas à droite : bouton d'édition, puis palette d'ajout en mode édition. */
function EditControls({
  editing,
  available,
  fits,
  onEdit,
  onDone,
  onReset,
  onAdd,
}: {
  editing: boolean;
  available: WidgetType[];
  fits: (type: WidgetType) => boolean;
  onEdit: () => void;
  onDone: () => void;
  onReset: () => void;
  onAdd: (type: WidgetType) => void;
}) {
  if (!editing) {
    return (
      <button
        type="button"
        onClick={onEdit}
        title="Personnaliser le tableau de bord"
        aria-label="Personnaliser le tableau de bord"
        className="absolute right-1.5 bottom-1.5 z-10 flex size-8 items-center justify-center rounded-full border bg-card/90 text-muted-foreground shadow-lg backdrop-blur transition-colors hover:border-primary/50 hover:text-primary"
      >
        <Pencil className="size-3.5" />
      </button>
    );
  }
  return (
    <div className="absolute right-5 bottom-5 z-10 grid w-72 grid-cols-1 gap-3 rounded-xl border border-primary/30 bg-card/95 p-3 shadow-xl backdrop-blur">
      <div className="grid min-w-0 grid-cols-1 gap-1">
        <p className="eyebrow px-1">Ajouter un widget</p>
        {available.length === 0 && <p className="px-1 text-xs text-muted-foreground">Tous les widgets sont affichés.</p>}
        {available.map((t) => {
          const def = WIDGETS[t];
          const Icon = def.icon;
          const ok = fits(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => onAdd(t)}
              disabled={!ok}
              title={ok ? undefined : "Pas assez de place : libérez de l'espace sur le tableau"}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors enabled:hover:bg-primary/10 enabled:hover:text-primary disabled:opacity-40"
            >
              <Icon className="size-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{def.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{ok ? def.description : "Pas assez de place"}</span>
              </span>
              <Plus className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          );
        })}
      </div>
      <div className="flex gap-2 border-t pt-3">
        <Button variant="ghost" size="sm" className="min-w-0 flex-1" onClick={onReset}>
          <RotateCcw /> Réinitialiser
        </Button>
        <Button size="sm" className="min-w-0 flex-1" onClick={onDone}>
          <Check /> Terminé
        </Button>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const tauri = isTauri();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [history, setHistory] = useState<DashboardData["history"]>({ cpu: [], mem: [], cores: [] });
  const { data: snap, error } = usePolling(api.system.snapshot, REFRESH_MS, tauri, {
    onData: (s) =>
      setHistory((h) => ({
        cpu: push(h.cpu, s.cpuUsage),
        mem: push(h.mem, s.memoryTotal ? (s.memoryUsed / s.memoryTotal) * 100 : 0),
        cores: s.cpuPerCore.map((v, i) => push(h.cores[i] ?? [], v)),
      })),
  });

  const [layout, setLayout] = useState<LayoutItem[]>(loadLayout);
  const [editing, setEditing] = useState(false);
  const [settings, setSettings] = useState<SettingsMap>(loadSettings);
  const [configuring, setConfiguring] = useState<WidgetType | null>(null);
  const updateSettings = useCallback((type: WidgetType, patch: Partial<WidgetSettings> | null) => {
    setSettings((prev) => {
      const merged: WidgetSettings = patch ? { ...prev[type], ...patch } : {};
      // Seules les valeurs différentes du défaut sont gardées (les clés à undefined sont retirées).
      const clean = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)) as WidgetSettings;
      const next = { ...prev, [type]: clean };
      saveSettings(next);
      return next;
    });
  }, []);
  const { width, containerRef, mounted } = useContainerWidth();

  // Hauteur visible du tableau : les widgets ne peuvent pas descendre plus bas.
  const boardRef = useRef<HTMLDivElement>(null);
  const [boardHeight, setBoardHeight] = useState(0);
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const measure = () => setBoardHeight(el.clientHeight - BOARD_PADDING * 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout.length === 0 && !editing]);

  useEffect(() => {
    if (tauri) api.system.info().then(setInfo).catch(() => {});
  }, [tauri]);

  const applyLayout = useCallback((next: Layout) => {
    // La bibliothèque renvoie les éléments sans leurs limites : on les réapplique.
    const items = next.filter((it) => isWidgetType(it.i)).map((it) => withConstraints(it as Parameters<typeof withConstraints>[0]));
    setLayout(items);
    saveLayout(items);
  }, []);

  const rowHeight = Math.max(MIN_ROW_HEIGHT, (boardHeight - (ROWS - 1) * GAP) / ROWS);

  const remove = useCallback(
    (type: WidgetType) =>
      setLayout((prev) => {
        const next = prev.filter((it) => it.i !== type);
        saveLayout(next);
        return next;
      }),
    [],
  );
  const add = (type: WidgetType) => {
    const spot = findFreeSpot(layout, type);
    if (spot) applyLayout([...layout, withConstraints({ i: type, ...spot })]);
  };

  const shown = new Set(layout.map((it) => it.i));
  const available = (Object.keys(WIDGETS) as WidgetType[]).filter((t) => !shown.has(t));
  const data = useMemo<DashboardData>(() => ({ snap, info, history }), [snap, info, history]);

  // Enfants stables : pendant un glisser, la grille se redessine à chaque mouvement de souris ;
  // sans ça, tous les widgets (et leurs graphiques SVG) seraient recalculés à chaque fois.
  const ids = layout.map((it) => it.i).join(",");
  const children = useMemo(
    () =>
      ids
        .split(",")
        .filter(isWidgetType)
        .map((t) => (
          <div key={t}>
            <WidgetFrame
              type={t}
              data={data}
              settings={settings[t] ?? NO_SETTINGS}
              editing={editing}
              onRemove={remove}
              onConfigure={setConfiguring}
            />
          </div>
        )),
    [ids, data, settings, editing, remove],
  );

  return (
    <Page>
      <PageMain>
        {!tauri && (
          <PageNotice tone="warning">Les métriques système ne sont disponibles que dans l'application (pnpm tauri dev).</PageNotice>
        )}
        {error && <PageNotice>{error}</PageNotice>}

        <div className="relative flex min-h-0 flex-1 flex-col">
        {layout.length === 0 && !editing ? (
          <EmptyState
            icon={LayoutGrid}
            title="Tableau de bord vide"
            text="Ajoutez des widgets pour suivre votre machine, vos workspaces et vos scripts."
            actions={
              <Button size="sm" onClick={() => setEditing(true)}>
                <Plus /> Ajouter des widgets
              </Button>
            }
          />
        ) : (
          <div ref={boardRef} className="min-h-0 flex-1 overflow-hidden" style={{ padding: BOARD_PADDING }}>
            <div
              ref={containerRef}
              className={cn("dashboard-grid h-full min-w-0", editing && "is-editing")}
              // En édition : un point au coin de chaque case, sur toute la zone utilisable.
              style={
                editing && width
                  ? ({
                      "--cell-w": `${(width + GAP) / COLS}px`,
                      "--cell-h": `${rowHeight + GAP}px`,
                    } as React.CSSProperties)
                  : undefined
              }
            >
              {mounted && boardHeight > 0 && (
                <GridLayout
                  layout={layout}
                  width={width}
                  gridConfig={{ cols: COLS, rowHeight, margin: [GAP, GAP], containerPadding: [0, 0], maxRows: ROWS }}
                  dragConfig={{ enabled: editing, handle: ".widget-handle", cancel: ".widget-nodrag" }}
                  resizeConfig={{ enabled: editing, handles: ["se"] }}
                  compactor={noCompactor}
                  onLayoutChange={applyLayout}
                  onDragStop={(l) => applyLayout(l)}
                  onResizeStop={(l) => applyLayout(l)}
                >
                  {children}
                </GridLayout>
              )}
            </div>
          </div>
        )}

        <EditControls
          editing={editing}
          available={available}
          fits={(t) => findFreeSpot(layout, t) !== null}
          onEdit={() => setEditing(true)}
          onDone={() => setEditing(false)}
          onReset={() => {
            applyLayout(defaultLayout());
            setSettings({});
            saveSettings({});
          }}
          onAdd={add}
        />
        </div>
        <WidgetSettingsDialog
          type={configuring}
          settings={(configuring && settings[configuring]) || NO_SETTINGS}
          onChange={(patch) => configuring && updateSettings(configuring, patch)}
          onReset={() => configuring && updateSettings(configuring, null)}
          onClose={() => setConfiguring(null)}
        />
      </PageMain>
    </Page>
  );
}
