import { useState } from "react";
import { Link } from "react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleDot, GitPullRequest, GitPullRequestDraft } from "lucide-react";

import { cn, formatRelative } from "@/lib/utils";
import { api } from "@/services/tauri";
import type { GithubInbox, GithubInboxItem } from "@/types";
import { RefreshButton } from "../activity";
import { readLocal, useWidgetPolling, writeLocal } from "./polling";

/** Recherche GitHub limitée (30 requêtes / min) : relecture lente. */
const GITHUB_MS = 5 * 60_000;
const TAB_KEY = "devcenter.dashboard.github.tab";

type Tab = "review" | "authored" | "assigned";
const TABS: { id: Tab; label: string; pick: (i: GithubInbox) => GithubInboxItem[]; empty: string }[] = [
  { id: "review", label: "Revues", pick: (i) => i.reviewRequested, empty: "Aucune revue demandée." },
  { id: "authored", label: "Mes PR", pick: (i) => i.authored, empty: "Aucune pull request ouverte." },
  { id: "assigned", label: "Issues", pick: (i) => i.assigned, empty: "Aucune issue assignée." },
];

function SettingsLink({ children }: { children: React.ReactNode }) {
  return (
    <Link to="/settings?tab=general" className="text-primary hover:underline">
      {children}
    </Link>
  );
}

/** PR où je suis auteur ou relecteur demandé, et issues qui me sont assignées (compte `gh`). */
export function GithubBody() {
  const { data, error, loading, refresh } = useWidgetPolling("github:inbox", api.github.inbox, GITHUB_MS);
  const [tab, setTabState] = useState<Tab>(() => {
    const t = readLocal<Tab>(TAB_KEY, "review");
    return TABS.some((x) => x.id === t) ? t : "review";
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    writeLocal(TAB_KEY, t);
  };

  if (error && !data) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Lecture de GitHub…</p>;
  if (!data.installed)
    return (
      <p className="text-sm text-muted-foreground">
        GitHub CLI (gh) n'est pas installé. Voir <SettingsLink>Paramètres</SettingsLink>.
      </p>
    );
  if (!data.login)
    return (
      <p className="text-sm text-muted-foreground">
        Aucun compte GitHub connecté. <SettingsLink>Se connecter dans Paramètres</SettingsLink>
      </p>
    );

  const current = TABS.find((t) => t.id === tab)!;
  const items = current.pick(data);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="inline-flex min-w-0 rounded-md border bg-background/40 p-px" role="tablist" aria-label="Catégorie">
          {TABS.map((t) => {
            const n = t.pick(data).length;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex items-center gap-1 truncate rounded-[5px] px-2 py-0.5 text-[11px] leading-4 transition-colors",
                  tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
                <span className={cn("font-mono tabular-nums", tab !== t.id && n > 0 && "text-primary")}>{n}</span>
              </button>
            );
          })}
        </div>
        <span className="ml-auto truncate text-[11px] text-muted-foreground" title={error ?? undefined}>
          {error ? <span className="text-destructive">Échec de la lecture</span> : `@${data.login}`}
        </span>
        <RefreshButton onClick={refresh} loading={loading} label="Actualiser GitHub" className="size-5" />
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{current.empty}</p>
      ) : (
        <ul className="grid min-h-0 content-start gap-1 overflow-y-auto">
          {items.map((it) => {
            const Icon = tab === "assigned" ? CircleDot : it.draft ? GitPullRequestDraft : GitPullRequest;
            const updated = Date.parse(it.updatedAt);
            return (
              <li key={it.url}>
                <button
                  type="button"
                  onClick={() => openUrl(it.url).catch(() => {})}
                  title={`${it.repo}#${it.number} : ${it.title}`}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-primary/5"
                >
                  <Icon className={cn("size-4 shrink-0", it.draft ? "text-muted-foreground" : "text-success")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{it.title}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {it.repo}#{it.number}
                      {it.draft && " · brouillon"}
                    </span>
                  </span>
                  {!Number.isNaN(updated) && <span className="meta shrink-0">{formatRelative(updated / 1000)}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
