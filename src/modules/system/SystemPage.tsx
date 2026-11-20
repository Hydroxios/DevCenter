import { useState } from "react";
import { AppWindow, Cpu, ListTree, Network } from "lucide-react";

import { Page, PageBar, PageBody, PageMain, PageTabs, TauriOnly } from "@/components/layout/Page";
import { isTauri } from "@/services/tauri";
import { AppLauncher } from "./AppLauncher";
import { HardwarePanel } from "./HardwarePanel";
import { PortsTable } from "./PortsTable";
import { ProcessTable } from "./ProcessTable";

type Tab = "hardware" | "apps" | "processes" | "ports";

/** Dernier onglet ouvert (le temps de la session de l'app). */
let lastTab: Tab = "hardware";

export function SystemPage() {
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (t: Tab) => {
    lastTab = t;
    setTabState(t);
  };
  if (!isTauri()) return <TauriOnly title="Système" />;
  return (
    <Page>
      <PageMain>
        <PageBar title="Système" meta="Matériel, applications, processus et ports de la machine" />
        <PageTabs
          tabs={[
            { id: "hardware", label: "Matériel", icon: Cpu },
            { id: "apps", label: "Applications", icon: AppWindow },
            { id: "processes", label: "Processus", icon: ListTree },
            { id: "ports", label: "Ports en écoute", icon: Network },
          ]}
          active={tab}
          onChange={setTab}
        />
        <PageBody>
          {tab === "hardware" && <HardwarePanel />}
          {tab === "apps" && <AppLauncher />}
          {tab === "processes" && <ProcessTable />}
          {tab === "ports" && <PortsTable />}
        </PageBody>
      </PageMain>
    </Page>
  );
}
