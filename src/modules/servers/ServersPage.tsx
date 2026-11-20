import { useCallback, useEffect, useState } from "react";
import { Box, Copy, Gauge, Pencil, Plus, Server as ServerIcon, Settings2, SquareChevronRight, TerminalSquare, Trash2, Zap } from "lucide-react";

import { EmptyState, ListItem, ListPane, Page, PageBar, PageBody, PageMain, PageNotice, PageTabs, TauriOnly } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm";
import { contextMenu, copyText } from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { api, isTauri } from "@/services/tauri";
import type { Server } from "@/types";
import { KeyHelp } from "./KeyHelp";
import { DockerPanel, OverviewPanel, ServicesPanel } from "./RemotePanels";
import { ServerDialog } from "./ServerDialog";
import { SnippetsPanel } from "./SnippetsPanel";
import { SshTerminal, sshKey } from "./SshTerminal";
import { remoteCache } from "./remoteCache";
import { terminals, useTerminalsVersion } from "./terminalManager";

type Tab = "overview" | "terminal" | "commands" | "services" | "docker";

/** Dernier onglet ouvert par serveur (conservé le temps de la session de l'app). */
const lastTab = new Map<number, Tab>();
const TABS: { id: Tab; label: string; icon: typeof Gauge }[] = [
  { id: "overview", label: "Aperçu", icon: Gauge },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "commands", label: "Commandes", icon: SquareChevronRight },
  { id: "services", label: "Services", icon: Settings2 },
  { id: "docker", label: "Docker", icon: Box },
];

/** État de connexion : latence en ms, message d'erreur, ou test en cours. */
type Status = { ok: true; ms: number } | { ok: false; error: string } | "checking";

function StatusDot({ status }: { status: Status | undefined }) {
  const title = !status || status === "checking" ? "Test en cours…" : status.ok ? `En ligne (${status.ms} ms)` : status.error;
  return (
    <span
      title={title}
      className={cn(
        "size-2 shrink-0 rounded-full",
        !status || status === "checking" ? "animate-pulse bg-muted-foreground/40" : status.ok ? "bg-success" : "bg-destructive",
      )}
    />
  );
}

function DeleteServer({ server, onDeleted }: { server: Server; onDeleted: (list: Server[]) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <Button variant="ghost" size="icon" className="size-8" onClick={() => setIsOpen(true)} aria-label="Supprimer le serveur" title="Supprimer">
        <Trash2 />
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Supprimer {server.name} ?</DialogTitle>
          <DialogDescription>Le serveur est retiré de DevCenter. Rien n'est modifié sur la machine distante ni dans vos clés.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setIsOpen(false)}>Annuler</Button>
          <Button
            variant="destructive"
            onClick={async () => {
              terminals.dispose(sshKey(server.id));
              remoteCache.forget(server.id);
              onDeleted(await api.servers.remove(server.id));
            }}
          >
            Supprimer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServerView({
  server,
  status,
  onTest,
  onEdit,
  onDeleted,
}: {
  server: Server;
  status: Status | undefined;
  onTest: () => void;
  onEdit: () => void;
  onDeleted: (list: Server[]) => void;
}) {
  const [tab, setTabState] = useState<Tab>(() => lastTab.get(server.id) ?? "overview");
  const setTab = (t: Tab) => {
    lastTab.set(server.id, t);
    setTabState(t);
  };
  const offline = status && status !== "checking" && !status.ok;

  return (
    <PageMain>
      <PageBar
        title={server.name}
        leading={<StatusDot status={status} />}
        meta={
          <>
            {server.user ? `${server.user}@` : ""}
            {server.host}
            {server.port !== 22 && `:${server.port}`}
            {server.keyPath && <span title={server.keyPath}> · clé {server.keyPath}</span>}
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={onTest} disabled={status === "checking"}>
              <Zap /> Tester
            </Button>
            <Button variant="ghost" size="icon" className="size-8" onClick={onEdit} aria-label="Modifier" title="Modifier">
              <Pencil />
            </Button>
            <DeleteServer server={server} onDeleted={onDeleted} />
          </>
        }
      />
      {offline && <PageNotice>{status.error}</PageNotice>}
      <PageTabs
        tabs={TABS.map((t) => ({ ...t, dot: t.id === "terminal" && terminals.info(sshKey(server.id)).state === "open" }))}
        active={tab}
        onChange={setTab}
      />
      <PageBody>
        {offline && <KeyHelp server={server} onFixed={onTest} />}
        {tab === "overview" && <OverviewPanel server={server} />}
        {tab === "commands" && <SnippetsPanel server={server} />}
        {tab === "services" && <ServicesPanel server={server} />}
        {tab === "docker" && <DockerPanel server={server} />}
        {/* La session SSH vit dans terminalManager : quitter l'onglet ou la page ne la coupe pas. */}
        {tab === "terminal" && <SshTerminal server={server} className="h-[max(320px,calc(100vh-260px))]" />}
      </PageBody>
    </PageMain>
  );
}

export function ServersPage() {
  if (!isTauri()) return <TauriOnly title="Serveurs" />;
  return <ServersView />;
}

/** Liste, statuts et sélection conservés entre deux visites de la page. */
const viewCache: {
  servers: Server[] | null;
  status: Record<number, Status>;
  checkedAt: Record<number, number>;
  selectedId: number | null;
} = { servers: null, status: {}, checkedAt: {}, selectedId: null };

const STATUS_TTL_MS = 60_000;

function ServersView() {
  const [servers, setServersState] = useState<Server[] | null>(viewCache.servers);
  const [status, setStatusState] = useState<Record<number, Status>>(viewCache.status);
  const [selectedId, setSelectedIdState] = useState<number | null>(viewCache.selectedId);
  const [dialog, setDialog] = useState<{ open: boolean; server: Server | null }>({ open: false, server: null });
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  useTerminalsVersion();

  const setServers = (list: Server[]) => {
    viewCache.servers = list;
    setServersState(list);
  };
  const setSelectedId = (id: number | null) => {
    viewCache.selectedId = id;
    setSelectedIdState(id);
  };
  const setStatus = useCallback((id: number, st: Status) => {
    viewCache.status = { ...viewCache.status, [id]: st };
    setStatusState(viewCache.status);
  }, []);

  const ping = useCallback(
    (id: number) => {
      // Pendant le test, on garde l'ancien statut affiché s'il existe.
      if (!viewCache.status[id]) setStatus(id, "checking");
      viewCache.checkedAt[id] = Date.now();
      api.servers
        .ping(id)
        .then((ms) => setStatus(id, { ok: true, ms }))
        .catch((e) => setStatus(id, { ok: false, error: String(e) }));
    },
    [setStatus],
  );

  /** Teste uniquement les serveurs jamais testés ou testés il y a plus d'une minute. */
  const pingStale = useCallback(
    (list: Server[]) => {
      const now = Date.now();
      list.forEach((s) => {
        if (now - (viewCache.checkedAt[s.id] ?? 0) > STATUS_TTL_MS) ping(s.id);
      });
    },
    [ping],
  );

  const apply = useCallback(
    (list: Server[]) => {
      setServers(list);
      pingStale(list);
    },
    [pingStale],
  );

  useEffect(() => {
    api.servers.list().then(apply).catch((e) => setError(String(e)));
  }, [apply]);

  // Statut rafraîchi toutes les 2 minutes, uniquement fenêtre visible.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") servers?.forEach((s) => ping(s.id));
    }, 120_000);
    return () => window.clearInterval(t);
  }, [servers, ping]);

  const selected = servers?.find((s) => s.id === selectedId) ?? servers?.[0] ?? null;

  const q = filter.trim().toLowerCase();
  const shown = (servers ?? []).filter((s) => !q || s.name.toLowerCase().includes(q) || s.host.toLowerCase().includes(q));
  const online = (servers ?? []).filter((s) => {
    const st = status[s.id];
    return st && st !== "checking" && st.ok;
  }).length;

  const serverMenu = (s: Server) =>
    contextMenu(() => {
      const target = `${s.user ? `${s.user}@` : ""}${s.host}`;
      return [
        { heading: s.name },
        {
          label: "Tester la connexion",
          icon: Zap,
          disabled: status[s.id] === "checking",
          onSelect: () => {
            setStatus(s.id, "checking");
            ping(s.id);
          },
        },
        { label: "Modifier…", icon: Pencil, onSelect: () => setDialog({ open: true, server: s }) },
        { separator: true },
        { label: "Copier l'adresse", icon: Copy, hint: target, onSelect: () => copyText(target) },
        { label: "Copier la commande SSH", icon: TerminalSquare, onSelect: () => copyText(`ssh ${s.port !== 22 ? `-p ${s.port} ` : ""}${target}`) },
        { separator: true },
        {
          label: "Supprimer",
          icon: Trash2,
          danger: true,
          onSelect: async () => {
            const ok = await confirmAction({ title: `Supprimer ${s.name} ?`, description: "Le serveur est retiré de DevCenter.", confirmLabel: "Supprimer" });
            if (!ok) return;
            try {
              const list = await api.servers.remove(s.id);
              setServers(list);
              if (selected?.id === s.id) setSelectedId(list[0]?.id ?? null);
            } catch (e) {
              setError(String(e));
            }
          },
        },
      ];
    });

  return (
    <Page>
      <ListPane
        title="Serveurs"
        count={servers ? `${servers.length} serveur${servers.length > 1 ? "s" : ""} · ${online} en ligne` : "…"}
        actions={
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setDialog({ open: true, server: null })} aria-label="Ajouter un serveur" title="Ajouter un serveur">
            <Plus />
          </Button>
        }
        filter={filter}
        onFilter={(servers?.length ?? 0) > 5 ? setFilter : undefined}
        error={error}
      >
        {shown.map((s) => (
          <ListItem key={s.id} active={selected?.id === s.id} onClick={() => setSelectedId(s.id)} onContextMenu={serverMenu(s)}>
            <span className="flex items-center gap-2">
              <StatusDot status={status[s.id]} />
              <span className={cn("truncate text-sm", selected?.id === s.id ? "text-foreground" : "text-foreground/85")}>{s.name}</span>
              {terminals.info(sshKey(s.id)).state === "open" && (
                <TerminalSquare className="ml-auto size-3.5 shrink-0 text-primary" aria-label="Terminal ouvert" />
              )}
            </span>
            <span className="truncate pl-4 font-mono text-xs text-muted-foreground">
              {s.user ? `${s.user}@` : ""}
              {s.host}
            </span>
          </ListItem>
        ))}
        {shown.length === 0 && servers && servers.length > 0 && <p className="px-3 py-2 text-sm text-muted-foreground">Aucun résultat.</p>}
      </ListPane>

      {servers && servers.length === 0 ? (
        <PageMain>
          <EmptyState
            icon={ServerIcon}
            title="Aucun serveur"
            text={<>Ajoutez un serveur Linux accessible en SSH par clé. Les hôtes de votre <code>~/.ssh/config</code> peuvent être utilisés directement.</>}
            actions={
              <Button onClick={() => setDialog({ open: true, server: null })}>
                <Plus /> Ajouter un serveur
              </Button>
            }
          />
        </PageMain>
      ) : (
        selected && (
          <ServerView
            key={selected.id}
            server={selected}
            status={status[selected.id]}
            onTest={() => {
              setStatus(selected.id, "checking");
              ping(selected.id);
            }}
            onEdit={() => setDialog({ open: true, server: selected })}
            onDeleted={(list) => {
              setServers(list);
              setSelectedId(list[0]?.id ?? null);
            }}
          />
        )
      )}

      <ServerDialog
        server={dialog.server}
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        onSaved={(list, name) => {
          const saved = dialog.server ? list.find((s) => s.id === dialog.server!.id) : list.find((s) => s.name === name);
          if (saved && dialog.server) {
            // Hôte, port ou clé ont pu changer : on oublie les anciennes données et on re-teste.
            remoteCache.forget(saved.id);
            delete viewCache.checkedAt[saved.id];
          }
          apply(list);
          if (saved) setSelectedId(saved.id);
        }}
      />
    </Page>
  );
}
