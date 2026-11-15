import { useState } from "react";
import { AppWindow, Cpu, ListTree } from "lucide-react";

import { Page, PageBar, PageBody, PageMain, PageTabs, TauriOnly } from "@/components/layout/Page";
import { isTauri } from "@/services/tauri";
import { AppLauncher } from "./AppLauncher";
import { HardwarePanel } from "./HardwarePanel";
import { ProcessTable } from "./ProcessTable";

type Tab = "hardware" | "apps" | "processes";

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
        <PageBar title="Système" meta="Matériel, applications et processus de la machine" />
        <PageTabs
          tabs={[
            { id: "hardware", label: "Matériel", icon: Cpu },
            { id: "apps", label: "Applications", icon: AppWindow },
            { id: "processes", label: "Processus", icon: ListTree },
          ]}
          active={tab}
          onChange={setTab}
        />
        <PageBody>
          {tab === "hardware" && <HardwarePanel />}
          {tab === "apps" && <AppLauncher />}
          {tab === "processes" && <ProcessTable />}
        </PageBody>
      </PageMain>
    </Page>
  );
}
