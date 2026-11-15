import { Suspense, lazy, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSearchParams } from "react-router";
import { Code2, FolderOpen, HardDriveDownload, Info, Monitor, Moon, SlidersHorizontal, Smartphone, Sun } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { GithubStatus } from "@/types";

import { Page, PageBar, PageBody, PageMain, PageNotice, PageTabs } from "@/components/layout/Page";
import { GithubIcon } from "@/components/GithubIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, isTauri } from "@/services/tauri";
import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";
import { AboutSettings } from "./AboutSettings";
import { BackupSettings } from "./BackupSettings";
import { RemoteSettings } from "./RemoteSettings";
import type { Theme } from "@/types";

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Clair", icon: Sun },
  { value: "dark", label: "Sombre", icon: Moon },
  { value: "system", label: "Système", icon: Monitor },
];

function Row({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 truncate text-sm text-muted-foreground" title={description}>{description}</p>
      </div>
      {children}
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
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
      <span
        className={cn(
          "inline-block size-5 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-5.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function EditorSetting() {
  const { settings, update } = useSettings();
  const [detected, setDetected] = useState<string | null>(null);

  useEffect(() => {
    if (isTauri()) api.projects.detectEditor().then(setDetected).catch(() => {});
  }, []);

  const browse = async () => {
    const file = await open({
      multiple: false,
      directory: false,
      title: "Choisir l'éditeur",
      filters: [{ name: "Éditeur", extensions: ["exe", "cmd", "bat"] }],
    });
    if (typeof file === "string") update("editorPath", file);
  };

  const current = settings.editorPath ?? detected;
  return (
    <Row
      title="Éditeur de code"
      description={
        current
          ? `${settings.editorPath ? "Choisi" : "Détecté automatiquement"} : ${current}`
          : "Aucun éditeur détecté (Cursor ou VS Code). Choisissez son exécutable."
      }
    >
      <div className="flex shrink-0 gap-2">
        {settings.editorPath && (
          <Button variant="ghost" size="sm" onClick={() => update("editorPath", null)}>
            Automatique
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={browse}>
          <Code2 /> Choisir…
        </Button>
      </div>
    </Row>
  );
}

const GithubLogin = lazy(() => import("./GithubLogin"));

function GithubSetting() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [login, setLogin] = useState(false);
  const refresh = () => api.github.status().then(setStatus).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  return (
    <Row
      title="Compte GitHub"
      description={
        !status
          ? "Vérification…"
          : !status.installed
            ? "GitHub CLI (gh) n'est pas installé : winget install GitHub.cli"
            : status.login
              ? `Connecté : ${status.login} — dépôts listés et clonés via gh (le jeton reste dans le gestionnaire d'identifiants Windows).`
              : "Non connecté : connectez-vous pour lister et cloner vos dépôts, privés compris."
      }
    >
      {status?.installed && (
        <Button variant={status.login ? "outline" : "default"} size="sm" onClick={() => setLogin(true)}>
          <GithubIcon /> {status.login ? "Changer de compte" : "Se connecter"}
        </Button>
      )}
      <Dialog open={login} onOpenChange={(o) => { setLogin(o); if (!o) refresh(); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Connexion à GitHub</DialogTitle>
            <DialogDescription>Authentification officielle de GitHub CLI : DevCenter ne voit ni votre mot de passe ni votre jeton.</DialogDescription>
          </DialogHeader>
          {login && (
            <Suspense fallback={null}>
              <GithubLogin
                onExit={() => {
                  window.setTimeout(() => {
                    setLogin(false);
                    refresh();
                  }, 1200);
                }}
              />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
    </Row>
  );
}

function ProjectsRootSetting() {
  const { settings, update } = useSettings();
  const browse = async () => {
    const dir = await open({ multiple: false, directory: true, title: "Dossier des projets" });
    if (typeof dir === "string") update("projectsRoot", dir);
  };
  return (
    <Row
      title="Dossier des projets"
      description={
        settings.projectsRoot
          ? `Les dépôts clonés depuis le téléphone vont dans ${settings.projectsRoot}`
          : "Automatique : le dossier qui contient le plus de vos projets. Les dépôts clonés depuis le téléphone y sont placés."
      }
    >
      <div className="flex shrink-0 gap-2">
        {settings.projectsRoot && (
          <Button variant="ghost" size="sm" onClick={() => update("projectsRoot", null)}>
            Automatique
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={browse}>
          <FolderOpen /> Choisir…
        </Button>
      </div>
    </Row>
  );
}

type SettingsTab = "general" | "remote" | "backup" | "about";
const TABS: SettingsTab[] = ["general", "remote", "backup", "about"];
let lastSettingsTab: SettingsTab = "general";

export function SettingsPage() {
  const { settings, update, error } = useSettings();
  // `?tab=about` : lien « mise à jour disponible » de la barre latérale.
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("tab") as SettingsTab | null;
  const [tab, setTabState] = useState<SettingsTab>(fromUrl && TABS.includes(fromUrl) ? fromUrl : lastSettingsTab);
  useEffect(() => {
    if (fromUrl && TABS.includes(fromUrl)) {
      lastSettingsTab = fromUrl;
      setTabState(fromUrl);
      setParams({}, { replace: true });
    }
  }, [fromUrl, setParams]);
  const setTab = (t: SettingsTab) => {
    lastSettingsTab = t;
    setTabState(t);
  };
  const tauri = isTauri();

  return (
    <Page>
      <PageMain>
      <PageBar title="Paramètres" meta="Préférences enregistrées localement (SQLite)" />
      {tauri && (
        <PageTabs
          tabs={[
            { id: "general", label: "Général", icon: SlidersHorizontal },
            { id: "remote", label: "Accès mobile", icon: Smartphone },
            { id: "backup", label: "Sauvegarde", icon: HardDriveDownload },
            { id: "about", label: "À propos", icon: Info },
          ]}
          active={tab}
          onChange={setTab}
        />
      )}
      {error && <PageNotice>{error}</PageNotice>}

      <PageBody className="max-w-3xl">
      {tab === "general" && (
      <Card className="gap-0 divide-y">
        <Row title="Thème" description="Apparence de l'interface.">
          <div className="flex rounded-lg border bg-secondary p-1" role="radiogroup" aria-label="Thème">
            {THEMES.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={settings.theme === value}
                onClick={() => update("theme", value)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                  settings.theme === value
                    ? "bg-card font-medium shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>
        </Row>
        <Row
          title="Réduire dans la barre système"
          description="Fermer la fenêtre garde DevCenter actif en arrière-plan. Quittez depuis l'icône de la barre système."
        >
          <Switch
            label="Réduire dans la barre système"
            checked={settings.closeToTray}
            onChange={(v) => update("closeToTray", v)}
          />
        </Row>
        <EditorSetting />
        {tauri && <ProjectsRootSetting />}
        {tauri && <GithubSetting />}
      </Card>
      )}
      {tauri && tab === "remote" && <RemoteSettings />}
      {tauri && tab === "backup" && <BackupSettings />}
      {tauri && tab === "about" && <AboutSettings />}
      </PageBody>
      </PageMain>
    </Page>
  );
}
