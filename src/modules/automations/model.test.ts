import { describe, expect, it } from "vitest";

import type { AutomationStep } from "@/types";
import { CONDITION_KINDS, DAYS, STEP_KINDS, defaultCondition, defaultStep, stepIcon, templates, triggerLabel } from "./model";
import type { Refs } from "./model";

const EMPTY: Refs = { projects: [], apps: [], workspaces: [], servers: [], snippets: [], tunnels: [] };
const REFS: Refs = {
  projects: [{ id: 11, name: "api" }, { id: 12, name: "web" }],
  apps: [{ id: 21, name: "Docker Desktop" }],
  workspaces: [{ id: 31, name: "Journée" }],
  servers: [{ id: 41, name: "vps" }],
  snippets: [{ id: 51, name: "Espace disque", serverId: null }],
  tunnels: [{ id: 61, name: "db (vps)" }],
};

describe("triggerLabel", () => {
  it("décrit les déclencheurs simples", () => {
    expect(triggerLabel({ kind: "manual" })).toBe("Manuel");
    expect(triggerLabel({ kind: "appStart" })).toBe("Au démarrage de DevCenter");
  });

  it("affiche un intervalle en minutes ou en heures rondes", () => {
    expect(triggerLabel({ kind: "interval", minutes: 5 })).toBe("Toutes les 5 min");
    expect(triggerLabel({ kind: "interval", minutes: 90 })).toBe("Toutes les 90 min");
    expect(triggerLabel({ kind: "interval", minutes: 60 })).toBe("Toutes les 1 h");
    expect(triggerLabel({ kind: "interval", minutes: 180 })).toBe("Toutes les 3 h");
  });

  it("résume les jours d'un déclencheur quotidien", () => {
    expect(triggerLabel({ kind: "daily", time: "09:00", days: [] })).toBe("09:00, tous les jours");
    expect(triggerLabel({ kind: "daily", time: "09:00", days: [0, 1, 2, 3, 4, 5, 6] })).toBe("09:00, tous les jours");
    expect(triggerLabel({ kind: "daily", time: "08:30", days: [4, 2, 0, 1, 3] })).toBe("08:30, en semaine");
    expect(triggerLabel({ kind: "daily", time: "10:00", days: [6, 5] })).toBe("10:00, Sam, Dim");
    // Cinq jours mais pas du lundi au vendredi : liste explicite, triée.
    expect(triggerLabel({ kind: "daily", time: "10:00", days: [6, 0, 1, 2, 3] })).toBe("10:00, Lun, Mar, Mer, Jeu, Dim");
  });

  it("ne modifie pas le tableau de jours reçu", () => {
    const days = [3, 1];
    triggerLabel({ kind: "daily", time: "07:00", days });
    expect(days).toEqual([3, 1]);
  });
});

describe("STEP_KINDS / stepIcon", () => {
  it("a un type unique par entrée et une icône pour chacune", () => {
    const kinds = STEP_KINDS.map((k) => k.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const k of STEP_KINDS) expect(stepIcon(k.kind)).toBe(k.icon);
  });

  it("utilise sept jours de la semaine, du lundi au dimanche", () => {
    expect(DAYS).toHaveLength(7);
    expect(DAYS[0]).toBe("Lun");
    expect(DAYS[6]).toBe("Dim");
  });
});

describe("defaultCondition", () => {
  it("couvre chaque type de condition et conserve le type demandé", () => {
    for (const { kind } of CONDITION_KINDS) {
      const c = defaultCondition(kind, REFS);
      expect(c.kind).toBe(kind);
      expect(typeof c.negate).toBe("boolean");
    }
  });

  it("reprend les premiers éléments disponibles", () => {
    expect(defaultCondition("serverReachable", REFS)).toEqual({ kind: "serverReachable", serverId: 41, negate: true });
    expect(defaultCondition("workspaceActive", REFS)).toEqual({ kind: "workspaceActive", workspaceId: 31, negate: false });
  });

  it("retombe sur l'identifiant 0 sans référence", () => {
    expect(defaultCondition("serverReachable", EMPTY)).toMatchObject({ serverId: 0 });
    expect(defaultCondition("workspaceActive", EMPTY)).toMatchObject({ workspaceId: 0 });
  });

  it("propose des valeurs par défaut cohérentes", () => {
    expect(defaultCondition("portOpen", EMPTY)).toEqual({ kind: "portOpen", host: "localhost", port: 3000, negate: false });
    expect(defaultCondition("cpuAbove", EMPTY)).toMatchObject({ percent: 90 });
    expect(defaultCondition("memoryAbove", EMPTY)).toMatchObject({ percent: 90 });
    expect(defaultCondition("timeBetween", EMPTY)).toMatchObject({ start: "09:00", end: "19:00" });
  });
});

describe("defaultStep", () => {
  it("produit une étape du bon type pour chaque entrée de STEP_KINDS", () => {
    for (const { kind } of STEP_KINDS) expect(defaultStep(kind, REFS).kind).toBe(kind);
  });

  it("utilise les premières références disponibles", () => {
    expect(defaultStep("startWorkspace", REFS)).toEqual({ kind: "startWorkspace", workspaceId: 31 });
    expect(defaultStep("runScript", REFS)).toEqual({ kind: "runScript", projectId: 11, script: "dev", openBrowser: false });
    expect(defaultStep("launchApp", REFS)).toEqual({ kind: "launchApp", appId: 21 });
    expect(defaultStep("openFolder", REFS)).toEqual({ kind: "openFolder", projectId: 11 });
  });

  it("retombe sur l'identifiant 0 sans référence", () => {
    expect(defaultStep("stopWorkspace", EMPTY)).toEqual({ kind: "stopWorkspace", workspaceId: 0 });
    expect(defaultStep("stopScript", EMPTY)).toEqual({ kind: "stopScript", projectId: 0, script: "dev" });
    expect(defaultStep("launchApp", EMPTY)).toEqual({ kind: "launchApp", appId: 0 });
  });

  it("imbrique une condition par défaut dans l'étape « condition »", () => {
    const step = defaultStep("condition", REFS) as Extract<AutomationStep, { kind: "condition" }>;
    expect(step.condition).toEqual(defaultCondition("processRunning", REFS));
  });

  it("propose une requête HTTP GET complète", () => {
    expect(defaultStep("httpRequest", EMPTY)).toEqual({
      kind: "httpRequest",
      method: "GET",
      url: "http://localhost:3000/health",
      headers: "",
      body: "",
      expectStatus: "",
      timeoutSecs: 30,
    });
  });
});

describe("templates", () => {
  it("a des identifiants uniques et des workflows prêts à créer", () => {
    const list = templates(REFS);
    expect(new Set(list.map((t) => t.id)).size).toBe(list.length);
    for (const t of list) {
      expect(t.input.id).toBeNull();
      expect(t.input.name).not.toBe("");
      expect(t.input.steps.length).toBeGreaterThan(0);
      expect(t.input.timeoutMinutes).toBeGreaterThan(0);
    }
  });

  it("n'utilise que des types d'étapes connus", () => {
    const known = new Set(STEP_KINDS.map((k) => k.kind));
    for (const t of templates(REFS)) for (const s of t.input.steps) expect(known.has(s.kind)).toBe(true);
  });

  it("injecte les références fournies", () => {
    const morning = templates(REFS).find((t) => t.id === "morning")!;
    expect(morning.input.steps[0]).toEqual({ kind: "startWorkspace", workspaceId: 31 });
    expect(morning.input.trigger).toEqual({ kind: "daily", time: "09:00", days: [0, 1, 2, 3, 4] });
    const watch = templates(REFS).find((t) => t.id === "server-watch")!;
    expect(watch.input.steps[0]).toEqual({ kind: "condition", condition: { kind: "serverReachable", serverId: 41, negate: true } });
  });

  it("n'ajoute l'étape « lancer une application » que si une application existe", () => {
    const withApp = templates(REFS).find((t) => t.id === "docker-first")!;
    expect(withApp.input.steps[0]).toEqual({ kind: "launchApp", appId: 21 });
    expect(withApp.input.onError).toBe("stop");
    const withoutApp = templates(EMPTY).find((t) => t.id === "docker-first")!;
    expect(withoutApp.input.steps.some((s) => s.kind === "launchApp")).toBe(false);
  });

  it("renvoie des objets neufs à chaque appel", () => {
    const a = templates(REFS);
    const b = templates(REFS);
    expect(a[0].input).not.toBe(b[0].input);
    expect(a).toEqual(b);
  });
});
